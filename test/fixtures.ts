import type { Quote, ScannerConfig } from '../src/types.ts';

/** A config that does not depend on config/default.json, so tests do not move when the defaults do. */
export function config(overrides: Partial<ScannerConfig> = {}): ScannerConfig {
  return {
    dte: { min: 37, max: 45 },
    delta: { min: 0.15, max: 0.25 },
    width: { min: 5, max: 10 },
    maxLegSpreadPct: 20,
    earnings: { minDaysSinceLast: 4, minDaysUntilNext: 37 },
    strikeSelection: { deltaSlack: 0.02, nearMarginEM: 0.15, farMarginEM: 0.35, rate: 0.04 },
    ...overrides,
  };
}

export function quote(side: Quote['side'], strike: number, bid: number, ask: number, delta: number, over: Partial<Quote> = {}): Quote {
  return { side, strike, expiration: '2026-12-04', dte: 41, bid, ask, delta, iv: 0.3, openInterest: 500, volume: 10, ...over };
}

export const close = (actual: number, expected: number, tolerance = 1e-6): void => {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${actual} is not within ${tolerance} of ${expected}`);
};
