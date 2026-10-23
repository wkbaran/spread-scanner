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

function pairAtWidths(legs: Quote[], side: Side, spot: number, cfg: ScannerConfig, widths: number[]): Spread[] {
  const out: Spread[] = [];
  for (const short of legs) {
    const delta = Math.abs(short.delta);
    if (!isOtm(short, spot) || delta < cfg.delta.min || delta > cfg.delta.max) continue;
    if (!legUsable(short, cfg)) continue;
    for (const w of widths) {
      const target = side === 'put' ? short.strike - w : short.strike + w;
      const long = legs.find((l) => l.strike === target && legUsable(l, cfg));
      const spread = long === undefined ? null : spreadMetrics(short, long);
      if (spread !== null) {
        out.push(spread);
        break; // the first width in the list that works is the one used for this short strike
      }
    }
  }
  return out;
}

/**
 * Credit spreads for one side of one chain. A short leg needs an absolute delta in range and a
 * usable bid-ask; so does its long leg. Per expiration, the widths are tried in order for each
 * short strike, and the fallback width is used only if no spread at all came out of them.
 */
export function pairSpreads(quotes: Quote[], side: Side, spot: number, cfg: ScannerConfig): Spread[] {
  const inWindow = quotes.filter((q) => q.side === side && q.dte >= cfg.dte.min && q.dte <= cfg.dte.max);
  const out: Spread[] = [];
  for (const expiration of new Set(inWindow.map((q) => q.expiration))) {
    const legs = inWindow.filter((q) => q.expiration === expiration);
    let found = pairAtWidths(legs, side, spot, cfg, cfg.widths);
    if (found.length === 0 && cfg.fallbackWidth !== null) {
      found = pairAtWidths(legs, side, spot, cfg, [cfg.fallbackWidth]);
    }
    out.push(...found);
  }
  return out;
}
