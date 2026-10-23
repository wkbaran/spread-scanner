import type { Cache } from './cache.ts';
import { addDays, dateWindows, daysBetween, easternDate } from './dates.ts';
import { earningsVerdict, requiredCoverage } from './earnings.ts';
import type { DailyBar, EarningsRow } from './providers/fmp.ts';
import type { InstrumentFlags, ListedContract, OptionQuoteData, SymbolMetrics } from './providers/tastytrade.ts';
import { pairSpreads, whyNoSpread } from './spread.ts';
import { strikesToQuote } from './strikes.ts';
import { historicalVolatility } from './volatility.ts';
import type { Candidate, Dropped, Quote, ScanResult, ScannerConfig, Side, SymbolInfo } from './types.ts';

export interface TastytradeLike {
  metrics(symbols: string[]): Promise<Map<string, SymbolMetrics>>;
  instruments(symbols: string[]): Promise<Map<string, InstrumentFlags>>;
  equityQuotes(symbols: string[]): Promise<Map<string, { mark: number }>>;
  chainListing(symbol: string): Promise<ListedContract[]>;
  optionQuotes(occs: string[]): Promise<Map<string, OptionQuoteData>>;
}

export interface FmpLike {
  earningsCalendar(from: string, to: string): Promise<EarningsRow[]>;
  dailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]>;
}

export interface ScanDeps {
  tt: TastytradeLike;
  fmp: FmpLike;
  cache: Cache;
  now?: Date;
  log?: (message: string) => void;
}

/** An IV index above this (300%) is a stale or illiquid print, and would ask for hundreds of strikes. */
const MAX_SIGMA = 3;
const CALENDAR_WINDOW_DAYS = 3;
const CALENDAR_TTL_MS = 12 * 3_600_000;
const CHAIN_TTL_MS = 20 * 3_600_000;
const BARS_TTL_MS = 12 * 3_600_000;
/** Calendar days of bars wanted: the 90-day volatility window plus slack for weekends and holidays. */
const BARS_DAYS = 130;
const SIDES: Side[] = ['put', 'call'];

/** Verdict reasons carry numbers; the dropped list groups them by what they mean. */
const coarseEarningsReason = (reason: string): string => {
  if (reason.startsWith('reported')) return 'earnings: reported too recently';
  if (reason.startsWith('reports in')) return 'earnings: reports too soon';
  return 'earnings: no report date known';
};

/**
 * Metrics, then earnings, then chains, then quotes, narrowing at every step so the expensive calls
 * (a chain listing is 100 KB and over a second) are made only for names that can still qualify.
 */
export async function scan(symbols: string[], cfg: ScannerConfig, deps: ScanDeps): Promise<ScanResult> {
  const { tt, fmp, cache } = deps;
  const now = deps.now ?? new Date();
  const today = easternDate(now);
  const log = deps.log ?? ((): void => undefined);
  const dropped = new Map<string, string[]>();
  const drop = (reason: string, symbol: string): void => {
    dropped.set(reason, [...(dropped.get(reason) ?? []), symbol]);
  };

  const universe = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s !== ''))];
  log(`${universe.length} symbols`);

  const metrics = await tt.metrics(universe);
  let alive = universe.filter((s) => metrics.has(s) || (drop('no metrics from tastytrade', s), false));

  const flags = await tt.instruments(alive);
  alive = alive.filter((s) => {
    const f = flags.get(s);
    if (f === undefined) return drop('not a listed equity or ETF', s), false;
    if (!f.active) return drop('inactive', s), false;
    if (f.optionsClosingOnly) return drop('options closing only', s), false;
    return true;
  });

  // Earnings. One calendar, fetched in 3-day windows because a long range is silently truncated.
  const coverage = requiredCoverage(today, cfg);
  const reportDates = new Map<string, string[]>();
  let calendarComplete = true;
  try {
    for (const window of dateWindows(coverage.from, coverage.to, CALENDAR_WINDOW_DAYS)) {
      const rows = await cache.getOrFetch(`fmp-earnings-${window.from}-${window.to}`, CALENDAR_TTL_MS, () => fmp.earningsCalendar(window.from, window.to));
      for (const row of rows) reportDates.set(row.symbol, [...(reportDates.get(row.symbol) ?? []), row.date]);
    }
  } catch (error) {
    calendarComplete = false;
    log(`earnings calendar unavailable (${error instanceof Error ? error.message : 'error'}); unknown dates will fail`);
  }

  const info = new Map<string, SymbolInfo>();
  alive = alive.filter((s) => {
    const m = metrics.get(s) as SymbolMetrics;
    const f = flags.get(s) as InstrumentFlags;
    // A fund has no earnings, so it has no earnings rule to fail.
    const verdict = f.isEtf
      ? { ok: true, reason: 'fund, no earnings', last: null, next: null, daysSinceLast: null, daysUntilNext: null }
      : earningsVerdict([...(reportDates.get(s) ?? []), ...(m.reportDate === null ? [] : [m.reportDate])], today, cfg, calendarComplete ? coverage : undefined);
    if (!verdict.ok) return drop(coarseEarningsReason(verdict.reason), s), false;
    if (m.ivIndex === null) return drop('no IV index', s), false;
    if (m.ivIndex > MAX_SIGMA) return drop('implausible IV index', s), false;
    info.set(s, {
      spot: 0,
      isEtf: f.isEtf,
      isIlliquid: f.isIlliquid,
      sector: m.sector,
      ivIndex: m.ivIndex,
      ivRank: m.ivRank,
      ivPercentile: m.ivPercentile,
      hv30: m.hv30,
      hv60: m.hv60,
      hv90: m.hv90,
      beta: m.beta,
      liquidityRating: m.liquidityRating,
      hvSource: m.hv30 !== null && m.hv60 !== null && m.hv90 !== null ? 'tastytrade' : null,
      reportDate: m.reportDate,
      reportTimeOfDay: m.reportTimeOfDay,
      earnings: verdict,
    });
    return true;
  });
  log(`${alive.length} pass the earnings and metrics filters`);

  const spots = await tt.equityQuotes(alive);
  alive = alive.filter((s) => {
    const spot = spots.get(s);
    if (spot === undefined) return drop('no stock quote', s), false;
    (info.get(s) as SymbolInfo).spot = spot.mark;
    return true;
  });

  // Chain listings (cached for the day), then only the contracts a short or long leg could be.
  type Plan = { symbol: string; side: Side; expiration: string; dte: number; contracts: Map<number, string> };
  const plans: Plan[] = [];
  alive = (
    await Promise.all(
      alive.map(async (symbol) => {
        const listing = await cache.getOrFetch(`chain-${symbol}`, CHAIN_TTL_MS, () => tt.chainListing(symbol));
        const i = info.get(symbol) as SymbolInfo;
        let any = false;
        for (const expiration of new Set(listing.map((c) => c.expiration))) {
          const dte = daysBetween(today, expiration);
          if (dte < cfg.dte.min || dte > cfg.dte.max) continue;
          for (const side of SIDES) {
            const sideContracts = listing.filter((c) => c.expiration === expiration && c.side === side);
            const byStrike = new Map(sideContracts.map((c) => [c.strike, c.occ] as const));
            const strikes = strikesToQuote([...byStrike.keys()].sort((a, b) => a - b), { spot: i.spot, sigma: i.ivIndex as number, years: dte / 365, rate: cfg.strikeSelection.rate }, side, cfg);
            if (strikes.length === 0) continue;
            plans.push({ symbol, side, expiration, dte, contracts: new Map(strikes.map((k) => [k, byStrike.get(k) as string] as const)) });
            any = true;
          }
        }
        if (!any) drop('no expiration in the DTE window', symbol);
        return any ? symbol : null;
      }),
    )
  ).filter((s): s is string => s !== null);

  const occs = plans.flatMap((p) => [...p.contracts.values()]);
  log(`${alive.length} names, ${occs.length} contracts to quote`);
  const quoted = await tt.optionQuotes(occs);

  const quotes = new Map<string, Quote[]>();
  for (const plan of plans) {
    for (const [strike, occ] of plan.contracts) {
      const q = quoted.get(occ);
      if (q === undefined) continue;
      quotes.set(plan.symbol, [...(quotes.get(plan.symbol) ?? []), { side: plan.side, strike, expiration: plan.expiration, dte: plan.dte, ...q }]);
    }
  }

  const candidates: Candidate[] = [];
  const kept: Record<string, SymbolInfo> = {};
  for (const symbol of alive) {
    const i = info.get(symbol) as SymbolInfo;
    const found = SIDES.flatMap((side) => pairSpreads(quotes.get(symbol) ?? [], side, i.spot, cfg));
    if (found.length === 0) {
      drop(`no spread: ${whyNoSpread(quotes.get(symbol) ?? [], i.spot, cfg)}`, symbol);
      continue;
    }
    kept[symbol] = i;
    for (const spread of found) candidates.push({ symbol, spread });
  }

  // tastytrade has no historical volatility for about 45% of names. Fill the gap from daily bars,
  // only for names that produced a spread, so the extra calls are few and cached for the day.
  for (const symbol of Object.keys(kept)) {
    const i = kept[symbol] as SymbolInfo;
    if (i.hvSource === 'tastytrade') continue;
    try {
      const bars = await cache.getOrFetch(`fmp-bars-${symbol}-${today}`, BARS_TTL_MS, () => fmp.dailyBars(symbol, addDays(today, -BARS_DAYS), today));
      const hv = { hv30: historicalVolatility(bars, 30), hv60: historicalVolatility(bars, 60), hv90: historicalVolatility(bars, 90) };
      i.hv30 ??= hv.hv30;
      i.hv60 ??= hv.hv60;
      i.hv90 ??= hv.hv90;
      i.hvSource = i.hv30 === null && i.hv60 === null && i.hv90 === null ? null : 'fmp bars';
    } catch (error) {
      log(`no price history for ${symbol} (${error instanceof Error ? error.message : 'error'})`);
    }
  }

  const droppedList: Dropped[] = [...dropped].map(([reason, list]) => ({ reason, symbols: list.sort() })).sort((a, b) => b.symbols.length - a.symbols.length);
  return { schema: 'spread-scanner/scan@1', generatedAt: now.toISOString(), today, config: cfg, universe: universe.length, dropped: droppedList, symbols: kept, candidates };
}
