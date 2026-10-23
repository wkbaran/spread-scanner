import { addDays } from './dates.ts';
import type { DailyBar } from './providers/fmp.ts';
import { percentRanks } from './rank.ts';
import type { RankedCandidate, RankedScan } from './types.ts';
import { historicalVolatility } from './volatility.ts';

/** The day the user closes a spread: this many days before it expires. */
export const EXIT_DTE = 21;

/** A forward window is only trusted when bars reach within this many days of its end. */
const WINDOW_SLACK_DAYS = 5;

export const closeOnOrBefore = (bars: DailyBar[], date: string): DailyBar | null => {
  let found: DailyBar | null = null;
  for (const bar of bars) {
    if (bar.date > date) break;
    found = bar;
  }
  return found;
};

/**
 * Annualised volatility over the `days` calendar days after `from`, as a fraction. Null when the
 * bars do not yet reach the end of the window, so a run that is still maturing is not scored.
 */
export function forwardVolatility(bars: DailyBar[], from: string, days: number): number | null {
  const end = addDays(from, days);
  const last = bars.at(-1);
  if (last === undefined || last.date < addDays(end, -WINDOW_SLACK_DAYS)) return null;
  const start = closeOnOrBefore(bars, from);
  if (start === null) return null;
  const window = bars.filter((b) => b.date >= start.date && b.date <= end);
  return historicalVolatility(window, days + 1);
}

/** Spearman's rank correlation, from the average ranks of both series. Null under 5 pairs or with no spread in either. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 5) return null;
  const a = percentRanks(x) as number[];
  const b = percentRanks(y) as number[];
  const mean = (v: number[]): number => v.reduce((s, n) => s + n, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let cross = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cross += da * db;
    va += da * da;
    vb += db * db;
  }
  return va === 0 || vb === 0 ? null : cross / Math.sqrt(va * vb);
}

export interface UnderlyingSample {
  symbol: string;
  date: string;
  ivIndex: number;
  forwardHv: number;
  ivOverHv: number | null;
  ivPercentile: number | null;
}

/** One underlying on one run date, if its 30-day window has played out. */
export function underlyingSamples(runs: RankedScan[], bars: Map<string, DailyBar[]>): UnderlyingSample[] {
  const out: UnderlyingSample[] = [];
  for (const run of runs) {
    for (const [symbol, info] of Object.entries(run.symbols)) {
      if (info.ivIndex === null) continue;
      const forwardHv = forwardVolatility(bars.get(symbol) ?? [], run.today, 30);
      if (forwardHv === null) continue;
      const blend = [info.hv30, info.hv60, info.hv90].filter((v): v is number => v !== null && v > 0);
      out.push({
        symbol,
        date: run.today,
        ivIndex: info.ivIndex,
        forwardHv,
        ivOverHv: blend.length === 0 ? null : info.ivIndex / (blend.reduce((a, b) => a + b, 0) / blend.length),
        ivPercentile: info.ivPercentile,
      });
    }
  }
  return out;
}

export interface SpreadOutcome {
  candidate: RankedCandidate;
  entry: string;
  exitDate: string;
  /** The underlying's close at the exit date, and where that left it against the strikes. */
  exitClose: number;
  /** Closed beyond the short strike on any day between entry and exit. */
  touchedShort: boolean;
  /** At the exit date, beyond the break-even: the spread was most likely losing. */
  beyondBreakeven: boolean;
}

const beyond = (side: 'put' | 'call', close: number, level: number): boolean => (side === 'put' ? close < level : close > level);

/**
 * Outcomes at the exit date for every spread whose exit date has passed. Each spread appears once,
 * at the first run that listed it: a scan repeated daily would otherwise count one trade many times.
 */
export function spreadOutcomes(runs: RankedScan[], bars: Map<string, DailyBar[]>, today: string): SpreadOutcome[] {
  const seen = new Set<string>();
  const out: SpreadOutcome[] = [];
  for (const run of [...runs].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))) {
    for (const candidate of run.candidates) {
      const s = candidate.spread;
      const key = [candidate.symbol, s.side, s.expiration, s.short.strike, s.long.strike].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const exitDate = addDays(s.expiration, -EXIT_DTE);
      const series = bars.get(candidate.symbol) ?? [];
      const last = series.at(-1);
      if (exitDate > today || exitDate <= run.today || last === undefined || last.date < addDays(exitDate, -WINDOW_SLACK_DAYS)) continue;
      const exit = closeOnOrBefore(series, exitDate);
      if (exit === null) continue;
      const between = series.filter((b) => b.date > run.today && b.date <= exitDate);
      out.push({
        candidate,
        entry: run.today,
        exitDate,
        exitClose: exit.close,
        touchedShort: between.some((b) => beyond(s.side, b.close, s.short.strike)),
        beyondBreakeven: beyond(s.side, exit.close, s.breakeven),
      });
    }
  }
  return out;
}

export interface Quintile {
  label: string;
  n: number;
  predictedPop: number;
  /** Share not beyond the break-even at the exit date, in percent. */
  heldBreakeven: number;
  /** Share that never closed beyond the short strike, in percent. */
  neverTouched: number;
}

export interface ValidationReport {
  runs: number;
  underlying: {
    n: number;
    ivAboveForward: number | null;
    meanEdge: number | null;
    ivOverHvCorrelation: number | null;
    ivPercentileCorrelation: number | null;
  };
  spreads: {
    n: number;
    scoreCorrelation: number | null;
    quintiles: Quintile[];
  };
}

const mean = (v: number[]): number | null => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length);

export function validationReport(runs: RankedScan[], bars: Map<string, DailyBar[]>, today: string): ValidationReport {
  const samples = underlyingSamples(runs, bars);
  const edge = samples.map((s) => s.ivIndex - s.forwardHv);
  const withHv = samples.filter((s) => s.ivOverHv !== null);
  const withPercentile = samples.filter((s) => s.ivPercentile !== null);

  const outcomes = spreadOutcomes(runs, bars, today);
  const byScore = [...outcomes].sort((a, b) => a.candidate.score - b.candidate.score);
  const quintiles: Quintile[] = [];
  if (byScore.length >= 5) {
    for (let q = 0; q < 5; q++) {
      const slice = byScore.slice(Math.floor((q * byScore.length) / 5), Math.floor(((q + 1) * byScore.length) / 5));
      quintiles.push({
        label: ['lowest scores', '2nd', 'middle', '4th', 'highest scores'][q] as string,
        n: slice.length,
        predictedPop: mean(slice.map((o) => o.candidate.spread.popPct)) as number,
        heldBreakeven: (slice.filter((o) => !o.beyondBreakeven).length / slice.length) * 100,
        neverTouched: (slice.filter((o) => !o.touchedShort).length / slice.length) * 100,
      });
    }
  }
  return {
    runs: runs.length,
    underlying: {
      n: samples.length,
      ivAboveForward: samples.length === 0 ? null : (edge.filter((e) => e > 0).length / samples.length) * 100,
      meanEdge: mean(edge),
      ivOverHvCorrelation: spearman(withHv.map((s) => s.ivOverHv as number), withHv.map((s) => s.ivIndex - s.forwardHv)),
      ivPercentileCorrelation: spearman(withPercentile.map((s) => s.ivPercentile as number), withPercentile.map((s) => s.ivIndex - s.forwardHv)),
    },
    spreads: {
      n: outcomes.length,
      scoreCorrelation: spearman(outcomes.map((o) => o.candidate.score), outcomes.map((o) => (o.beyondBreakeven ? 0 : 1))),
      quintiles,
    },
  };
}

const fmt = (v: number | null, digits = 2): string => (v === null ? 'n/a' : v.toFixed(digits));

export function formatValidation(r: ValidationReport): string {
  const lines = [`${r.runs} runs old enough to check`];
  lines.push('', `Underlyings: ${r.underlying.n} (run date, symbol) pairs whose next 30 days have played out`);
  if (r.underlying.n > 0) {
    lines.push(
      `  IV was above the volatility that followed in ${fmt(r.underlying.ivAboveForward, 0)}% of them; on average ${fmt((r.underlying.meanEdge ?? 0) * 100, 1)} vol points above`,
      `  rank correlation of IV/HV with that edge: ${fmt(r.underlying.ivOverHvCorrelation)}   of IV percentile with it: ${fmt(r.underlying.ivPercentileCorrelation)}`,
    );
  }
  lines.push('', `Spreads: ${r.spreads.n} (each counted once) whose exit date has passed`);
  if (r.spreads.quintiles.length > 0) {
    lines.push('  score quintile      n   predicted PoP   held break-even   never touched the short strike');
    for (const q of r.spreads.quintiles) lines.push(`  ${q.label.padEnd(16)} ${String(q.n).padStart(4)}   ${fmt(q.predictedPop, 0).padStart(10)}%   ${fmt(q.heldBreakeven, 0).padStart(12)}%   ${fmt(q.neverTouched, 0).padStart(10)}%`);
    lines.push(`  rank correlation of score with holding the break-even: ${fmt(r.spreads.scoreCorrelation)}`);
  }
  const few = r.underlying.n < 100 || r.spreads.n < 100;
  lines.push('', few
    ? 'Too few samples to conclude anything yet. Samples from the same week share one market, so they count for less than their number; keep scanning for several weeks before trusting a correlation.'
    : 'Samples from the same week share one market, so treat these as indications, not proof.');
  lines.push('This checks the underlying against the exit date only. It does not reprice the options, so it cannot say what a spread was worth.');
  return lines.join('\n');
}
