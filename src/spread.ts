import type { Quote, ScannerConfig, Side, Spread } from './types.ts';

const mid = (q: Pick<Quote, 'bid' | 'ask'>): number => (q.bid + q.ask) / 2;

/**
 * (ask - bid) / mid, in percent: the cost of crossing one option's spread, relative to what it is
 * worth. Infinity when there is no bid or the quote is crossed, so such an option never passes.
 * OptionStrat's "Wide bid/ask spread" warning uses the same figure ((bid - ask) / (bid + half the
 * spread), which is the mid).
 */
export function legSpreadPct(q: Pick<Quote, 'bid' | 'ask'>): number {
  if (!(q.bid > 0) || q.ask < q.bid) return Infinity;
  return ((q.ask - q.bid) / mid(q)) * 100;
}

const isOtm = (q: Quote, spot: number): boolean => (q.side === 'put' ? q.strike < spot : q.strike > spot);

const legUsable = (q: Quote, cfg: ScannerConfig): boolean => legSpreadPct(q) <= cfg.maxLegSpreadPct;

/** Credit, risk and odds for one pair. Null when the pair is not a credit at the mid. */
export function spreadMetrics(short: Quote, long: Quote): Spread | null {
  const side: Side = short.side;
  const width = Math.abs(short.strike - long.strike);
  const creditMid = mid(short) - mid(long);
  if (!(creditMid > 0) || !(width > 0) || creditMid >= width) return null;
  const creditNatural = short.bid - long.ask;
  const risk = width - creditMid;
  const breakeven = side === 'put' ? short.strike - creditMid : short.strike + creditMid;
  // Delta at the break-even, interpolated between the legs. A put's chance of finishing above
  // it is 1 - |delta|; a call's chance of finishing below it is the same.
  const t = (breakeven - short.strike) / (long.strike - short.strike);
  const deltaAtBreakeven = Math.abs(short.delta) + (Math.abs(long.delta) - Math.abs(short.delta)) * t;
  return {
    side,
    expiration: short.expiration,
    dte: short.dte,
    short,
    long,
    width,
    creditMid,
    creditNatural,
    maxRisk: risk * 100,
    profitPct: (creditMid / risk) * 100,
    breakeven,
    popPct: (1 - deltaAtBreakeven) * 100,
    slippagePct: ((creditMid - creditNatural) / creditMid) * 100,
  };
}

/**
 * Credit spreads for one side of one chain. A short leg needs an absolute delta in range and a
 * usable bid-ask; so does its long leg. Every usable long leg a permitted width past the short is
 * paired with it, so one short strike can yield several spreads. Choosing among widths is left to
 * whoever reads the result: the report filters by width.
 */
export function pairSpreads(quotes: Quote[], side: Side, spot: number, cfg: ScannerConfig): Spread[] {
  const { min, max } = cfg.width;
  const legs = quotes.filter((q) => q.side === side && q.dte >= cfg.dte.min && q.dte <= cfg.dte.max);
  const out: Spread[] = [];
  for (const short of legs) {
    const delta = Math.abs(short.delta);
    if (!isOtm(short, spot) || delta < cfg.delta.min || delta > cfg.delta.max) continue;
    if (!legUsable(short, cfg)) continue;
    for (const long of legs) {
      if (long.expiration !== short.expiration || !legUsable(long, cfg)) continue;
      const width = side === 'put' ? short.strike - long.strike : long.strike - short.strike;
      if (width < min || width > max) continue;
      const spread = spreadMetrics(short, long);
      if (spread !== null) out.push(spread);
    }
  }
  return out.sort((a, b) => a.expiration.localeCompare(b.expiration) || a.short.strike - b.short.strike || a.width - b.width);
}

/**
 * Why a name with quotes produced no spread: the furthest stage any side reached. Distinguishes a
 * rule doing its job (a weekly's options are too wide to use) from a gap in the data (no strike
 * near the target delta was quoted), which "no spread passed the filters" would hide.
 */
export function whyNoSpread(quotes: Quote[], spot: number, cfg: ScannerConfig): string {
  const inWindow = quotes.filter((q) => q.dte >= cfg.dte.min && q.dte <= cfg.dte.max);
  if (inWindow.length === 0) return 'no quotes in the DTE window';
  const { min, max } = cfg.width;
  let stage = 1;
  for (const side of ['put', 'call'] as const) {
    const legs = inWindow.filter((q) => q.side === side);
    const shorts = legs.filter((q) => isOtm(q, spot) && Math.abs(q.delta) >= cfg.delta.min && Math.abs(q.delta) <= cfg.delta.max);
    if (shorts.length > 0) stage = Math.max(stage, 2);
    for (const short of shorts.filter((q) => legUsable(q, cfg))) {
      stage = Math.max(stage, 3);
      const longs = legs.filter((l) => {
        const width = side === 'put' ? short.strike - l.strike : l.strike - short.strike;
        return l.expiration === short.expiration && width >= min && width <= max && legUsable(l, cfg);
      });
      if (longs.length > 0) stage = Math.max(stage, 4);
    }
  }
  return ['', 'no short leg at the target delta', 'short leg bid-ask too wide', 'no long leg in the width range with a usable bid-ask', 'no pair gives a credit'][stage] as string;
}
