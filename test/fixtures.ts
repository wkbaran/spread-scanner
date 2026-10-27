import type { Quote, ScannerConfig } from '../src/types.ts';

/** A config that does not depend on config/default.json, so tests do not move when the defaults do. */
export function config(overrides: Partial<ScannerConfig> = {}): ScannerConfig {
  return {
    dte: { min: 37, max: 45 },
    delta: { min: 0.15, max: 0.25 },
    width: { min: 5, max: 10 },
    maxLegSpreadPct: 20,
    minLegActivity: 10,
    earnings: { minDaysSinceLast: 4, minDaysUntilNext: 37 },
    ranking: { weights: { ivPercentile: 0.2, ivOverHv: 0.3, returnOnRisk: 0.25, pop: 0.15, legSpread: 0.1, distance: 0 } },
    universe: { minLiquidityRating: 4, maxNames: 250 },
    outcome: { takeProfit: 0.5, stopLoss: 0.25, exitDte: 21, fillShare: 0.5, volEdge: 0, ivDecay: 0, paths: 400, intraday: 3 },
    display: { timeZone: 'America/New_York' },
    strikeSelection: { deltaSlack: 0.02, nearMarginEM: 0.15, farMarginEM: 0.35, rate: 0.04, rateFromSofr: false },
    ...overrides,
  };
}

export function quote(side: Quote['side'], strike: number, bid: number, ask: number, delta: number, over: Partial<Quote> = {}): Quote {
  return { side, strike, expiration: '2026-12-04', dte: 41, bid, ask, delta, iv: 0.3, openInterest: 500, volume: 10, ...over };
}

export const close = (actual: number, expected: number, tolerance = 1e-6): void => {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${actual} is not within ${tolerance} of ${expected}`);
};
