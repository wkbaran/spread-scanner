import { addDays } from './dates.ts';
import type { DailyBar } from './providers/fmp.ts';

/**
 * Annualised close-to-close volatility over the bars dated within `calendarDays` of the last bar,
 * as a fraction. tastytrade's 30-day figure matches this to about a point on most names (22
 * trading-day returns). Null when fewer than 10 returns fit the window. Bars must be oldest first.
 */
export function historicalVolatility(bars: DailyBar[], calendarDays: number): number | null {
  const last = bars.at(-1);
  if (last === undefined) return null;
  const from = addDays(last.date, -calendarDays);
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i] as DailyBar;
    const previous = bars[i - 1] as DailyBar;
    if (bar.date > from && previous.close > 0 && bar.close > 0) returns.push(Math.log(bar.close / previous.close));
  }
  if (returns.length < 10) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
}

/** The average of whichever of the 30, 60 and 90-day figures exist. */
export function blendedVolatility(hv: { hv30: number | null; hv60: number | null; hv90: number | null }): number | null {
  const present = [hv.hv30, hv.hv60, hv.hv90].filter((v): v is number => v !== null && v > 0);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}
