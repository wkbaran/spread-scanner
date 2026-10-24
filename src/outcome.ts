import { addDays } from './dates.ts';
import type { Candidate, OutcomeConfig, Outcome, Side, SymbolInfo } from './types.ts';
import { blendedVolatility } from './volatility.ts';

/**
 * What a spread is worth to someone who manages it the way they do: a resting order at the profit target,
 * a stop checked on each day's close, and a time exit before expiration. The chance of profit in the table is
 * the chance of finishing profitable at expiration, which is not that: nobody who exits early ever gets there.
 *
 * Monte Carlo over the stock's path, repricing both legs with Black-Scholes at their own implied volatility each
 * step. Paths are drawn from one fixed seed and shared by every candidate (common random numbers), so the result
 * is the same on every run and candidates are compared on the same markets rather than on luck.
 */

const SEED = 20261023;
const DAYS_IN_YEAR = 365;

/** Standard normal CDF, Abramowitz and Stegun 26.2.17 (absolute error under 1e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = 0.3989422804014327 * Math.exp((-x * x) / 2) * poly;
  return x >= 0 ? 1 - tail : tail;
}

/** Black-Scholes price of a European option on a stock paying no dividend. */
export function blackScholes(side: Side, spot: number, strike: number, sigma: number, years: number, rate: number): number {
  if (years <= 0) return Math.max(0, side === 'call' ? spot - strike : strike - spot);
  const sd = sigma * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * years) / sd;
  const d2 = d1 - sd;
  const discount = Math.exp(-rate * years);
  return side === 'call' ? spot * normalCdf(d1) - strike * discount * normalCdf(d2) : strike * discount * normalCdf(-d2) - spot * normalCdf(-d1);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `paths` rows of `steps` standard normals, in antithetic pairs (the second of a pair is the mirror of the first). */
export function drawNormals(paths: number, steps: number, seed: number = SEED): Float64Array[] {
  const next = mulberry32(seed);
  const rows: Float64Array[] = [];
  for (let p = 0; p < paths; p += 2) {
    const row = new Float64Array(steps);
    for (let i = 0; i < steps; i += 2) {
      const r = Math.sqrt(-2 * Math.log(1 - next()));
      const angle = 2 * Math.PI * next();
      row[i] = r * Math.cos(angle);
      if (i + 1 < steps) row[i + 1] = r * Math.sin(angle);
    }
    rows.push(row, row.map((z) => -z));
  }
  return rows.slice(0, paths);
}

/** The weekdays after `today` up to and including `last`, each with the calendar days since the previous one. */
export function tradingSchedule(today: string, last: string): Array<{ date: string; gapDays: number; elapsedDays: number }> {
  const out: Array<{ date: string; gapDays: number; elapsedDays: number }> = [];
  let elapsed = 0;
  for (let date = addDays(today, 1); date <= last; date = addDays(date, 1)) {
    elapsed += 1;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    out.push({ date, gapDays: elapsed - (out.at(-1)?.elapsedDays ?? 0), elapsedDays: elapsed });
  }
  return out;
}

export interface SimulationInput {
  side: Side;
  spot: number;
  shortStrike: number;
  longStrike: number;
  shortIv: number;
  longIv: number;
  /** Calendar days from the scan date to expiration. */
  dte: number;
  creditMid: number;
  creditNatural: number;
  /** The volatility the stock's path is drawn at. */
  pathSigma: number;
  rate: number;
  today: string;
  expiration: string;
}

/**
 * The outcome of one spread under the exit rules. `normals` must have at least `paths` rows and as many columns as
 * the schedule has days times `cfg.intraday`.
 */
export function simulateManaged(input: SimulationInput, cfg: OutcomeConfig, normals: Float64Array[]): Outcome {
  const width = Math.abs(input.shortStrike - input.longStrike);
  const half = cfg.fillShare * (input.creditMid - input.creditNatural);
  const credit = input.creditMid - half; // what is actually collected on the way in
  const exitCost = half; // and what crossing the market costs on the way out
  const maxLoss = width - credit;
  const target = (1 - cfg.takeProfit) * credit; // buy the spread back at or below this
  const stopLevel = credit + cfg.stopLoss * maxLoss; // a closing debit at or above this stops the trade out
  const lastDay = addDays(input.expiration, -cfg.exitDte);
  const schedule = tradingSchedule(input.today, lastDay);

  // Implied volatility drifts down as a position ages, because the term structure usually slopes up and the
  // position rolls down it: each leg's IV falls linearly to (1 - ivDecay) of itself by the time exit.
  const horizonDays = Math.max(1, input.dte - cfg.exitDte);
  const model = (spot: number, daysLeft: number): number => {
    const years = Math.max(daysLeft, 0) / DAYS_IN_YEAR;
    const shrink = 1 - cfg.ivDecay * Math.min(1, Math.max(0, input.dte - daysLeft) / horizonDays);
    return (
      blackScholes(input.side, spot, input.shortStrike, input.shortIv * shrink, years, input.rate) -
      blackScholes(input.side, spot, input.longStrike, input.longIv * shrink, years, input.rate)
    );
  };
  const start = model(input.spot, input.dte);
  // The market's value of the spread is its mid today, moved by what the model says has happened since.
  const debitAt = (spot: number, daysLeft: number): number => Math.min(width, Math.max(0, input.creditMid + (model(spot, daysLeft) - start) + exitCost));

  let wins = 0;
  let losses = 0;
  let winSum = 0;
  let lossSum = 0;
  let hitTarget = 0;
  let hitStop = 0;
  let timed = 0;
  const sub = cfg.intraday;
  for (let p = 0; p < cfg.paths; p++) {
    const z = normals[p] as Float64Array;
    let spot = input.spot;
    let step = 0;
    let pnl: number | null = null;
    let reason: 'target' | 'stop' | 'time' = 'time';
    for (let d = 0; d < schedule.length && pnl === null; d++) {
      const day = schedule[d] as { gapDays: number; elapsedDays: number };
      const before = day.elapsedDays - day.gapDays;
      for (let k = 1; k <= sub; k++) {
        const dt = day.gapDays / sub / DAYS_IN_YEAR;
        spot *= Math.exp((input.rate - (input.pathSigma * input.pathSigma) / 2) * dt + input.pathSigma * Math.sqrt(dt) * (z[step++] as number));
        const daysLeft = input.dte - (before + (day.gapDays * k) / sub);
        const debit = debitAt(spot, daysLeft);
        if (debit <= target) {
          pnl = cfg.takeProfit * credit; // a resting order fills at its price, however the stock got there
          reason = 'target';
          break;
        }
        if (k === sub && debit >= stopLevel) {
          pnl = credit - debit; // the stop is a market order after the close: it fills where the market is
          reason = 'stop';
          break;
        }
      }
    }
    if (pnl === null) pnl = credit - debitAt(spot, input.dte - (schedule.at(-1)?.elapsedDays ?? 0));
    if (reason === 'target') hitTarget++;
    else if (reason === 'stop') hitStop++;
    else timed++;
    if (pnl > 0) {
      wins++;
      winSum += pnl;
    } else {
      losses++;
      lossSum += -pnl;
    }
  }
  const n = cfg.paths;
  const avgWin = wins === 0 ? 0 : (winSum / wins) * 100;
  const avgLoss = losses === 0 ? 0 : (lossSum / losses) * 100;
  const breakEven = avgWin + avgLoss === 0 ? 0 : (avgLoss / (avgWin + avgLoss)) * 100;
  const winRate = (wins / n) * 100;
  return {
    winRate,
    pTarget: (hitTarget / n) * 100,
    pStop: (hitStop / n) * 100,
    pTime: (timed / n) * 100,
    avgWin,
    avgLoss,
    ev: ((winSum - lossSum) / n) * 100,
    breakEvenWinRate: breakEven,
    edge: winRate - breakEven,
  };
}

/**
 * The volatility to draw the stock's path at: the short option's own implied volatility, moved toward the stock's
 * recent realised volatility by `volEdge` (0 trusts the options' price, 1 trusts the history). At 0 an option
 * priced fairly has no edge, so what a spread shows is its structure: what the exits and the costs do to it.
 */
export function pathVolatility(shortIv: number, info: Pick<SymbolInfo, 'hv30' | 'hv60' | 'hv90'>, volEdge: number): number {
  const realised = blendedVolatility(info);
  return realised === null || volEdge === 0 ? shortIv : shortIv * (1 - volEdge) + realised * volEdge;
}

/** Fills in `outcome` on every candidate. Candidates without an IV on both legs are left without one. */
export function attachOutcomes(candidates: Candidate[], symbols: Record<string, SymbolInfo>, cfg: OutcomeConfig, rate: number, today: string): void {
  if (candidates.length === 0) return;
  const longest = Math.max(...candidates.map((c) => tradingSchedule(today, addDays(c.spread.expiration, -cfg.exitDte)).length));
  const normals = drawNormals(cfg.paths, longest * cfg.intraday);
  for (const c of candidates) {
    const s = c.spread;
    const info = symbols[c.symbol] as SymbolInfo;
    if (!(s.short.iv > 0) || !(s.long.iv > 0)) continue;
    c.outcome = simulateManaged(
      {
        side: s.side,
        spot: info.spot,
        shortStrike: s.short.strike,
        longStrike: s.long.strike,
        shortIv: s.short.iv,
        longIv: s.long.iv,
        dte: s.dte,
        creditMid: s.creditMid,
        creditNatural: s.creditNatural,
        pathSigma: pathVolatility(s.short.iv, info, cfg.volEdge),
        rate,
        today,
        expiration: s.expiration,
      },
      cfg,
      normals,
    );
  }
}
