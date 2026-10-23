import type { ScannerConfig, Side } from './types.ts';

/**
 * Neither tastytrade nor Schwab can filter a chain by delta, and tastytrade's quote call takes
 * only contract symbols, capped at 100 a request. So the delta range is turned into a strike
 * range here, from the spot and the 30-day IV index, and only those contracts are quoted.
 * Measured on ten names: every short the broad pull found was found again, from about 22
 * contracts a symbol instead of 74.
 */

/** Inverse of the standard normal CDF (Acklam's rational approximation, good to about 1e-9). */
export function normalInverse(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0, 1), got ${p}`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const at = (xs: number[], i: number): number => xs[i] as number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  }
  if (p > 1 - 0.02425) return -normalInverse(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)) * q) /
    (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1);
}

export interface StrikeInput {
  spot: number;
  /** Annualised implied volatility as a fraction. */
  sigma: number;
  /** Years to expiration. */
  years: number;
  rate: number;
}

/** The strike where an out-of-the-money option has the given absolute delta, under one flat volatility. */
export function strikeAtDelta(input: StrikeInput & { delta: number; side: Side }): number {
  const { spot, sigma, years, rate, delta, side } = input;
  const d1 = normalInverse(1 - delta);
  const sd = sigma * Math.sqrt(years);
  const drift = (rate + (sigma * sigma) / 2) * years;
  return side === 'put' ? spot * Math.exp(-(d1 * sd - drift)) : spot * Math.exp(d1 * sd + drift);
}

/** One expected move: spot x sigma x sqrt(years). */
export const expectedMove = (i: Pick<StrikeInput, 'spot' | 'sigma' | 'years'>): number =>
  i.spot * i.sigma * Math.sqrt(i.years);

/** Strikes a short leg could have, between the two delta edges (with slack) and a margin for skew. */
export function shortStrikeBand(input: StrikeInput, side: Side, cfg: ScannerConfig): { low: number; high: number } {
  const { deltaSlack, nearMarginEM, farMarginEM } = cfg.strikeSelection;
  const em = expectedMove(input);
  const near = strikeAtDelta({ ...input, side, delta: cfg.delta.max + deltaSlack });
  const far = strikeAtDelta({ ...input, side, delta: cfg.delta.min - deltaSlack });
  return side === 'put'
    ? { low: far - farMarginEM * em, high: near + nearMarginEM * em }
    : { low: near - nearMarginEM * em, high: far + farMarginEM * em };
}

/**
 * The strikes to quote for one side of one expiration: every strike in the short band, plus every
 * listed strike a permitted width past it. `grid` is the expiration's strikes from the chain listing.
 */
export function strikesToQuote(grid: number[], input: StrikeInput, side: Side, cfg: ScannerConfig): number[] {
  const { low, high } = shortStrikeBand(input, side, cfg);
  const { min, max } = cfg.width;
  const wanted = new Set<number>();
  for (const strike of grid) {
    if (strike < low || strike > high) continue;
    wanted.add(strike);
    for (const far of grid) {
      const w = side === 'put' ? strike - far : far - strike;
      if (w >= min && w <= max) wanted.add(far);
    }
  }
  return [...wanted].sort((x, y) => x - y);
}
