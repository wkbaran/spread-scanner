import { spreadMetrics } from '../src/spread.ts';
import type { RankedCandidate, RankedScan, SymbolInfo } from '../src/types.ts';
import { config, quote } from './fixtures.ts';
import assert from 'node:assert/strict';

export const info = (iv: number, over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  spot: 100, isEtf: false, isIlliquid: false, sector: null, ivIndex: iv, ivRank: 0.5, ivPercentile: 0.5, hv30: 0.2, hv60: 0.2, hv90: 0.2,
  beta: 1, liquidityRating: 4, hvSource: 'tastytrade', reportDate: null, reportTimeOfDay: null,
  earnings: { ok: true, reason: 'clear', last: null, next: null, daysSinceLast: null, daysUntilNext: null }, ...over,
});

export function ranked(symbol: string, score: number, over: { expiration?: string; shortStrike?: number; side?: 'put' | 'call' } = {}): RankedCandidate {
  const side = over.side ?? 'put';
  const shortStrike = over.shortStrike ?? 90;
  const longStrike = side === 'put' ? shortStrike - 5 : shortStrike + 5;
  const expiration = over.expiration ?? '2026-10-23';
  const spread = spreadMetrics(
    quote(side, shortStrike, 1.0, 1.1, side === 'put' ? -0.2 : 0.2, { expiration, dte: 52 }),
    quote(side, longStrike, 0.4, 0.44, side === 'put' ? -0.1 : 0.1, { expiration, dte: 52 }),
  );
  assert.ok(spread);
  const ranks = { ivPercentile: 0.5, ivOverHv: 0.5, returnOnRisk: 0.5, pop: 0.5, legSpread: 0.5, distance: 0.5 };
  return { symbol, spread, score, ranks, components: { ivPercentile: 0.5, ivOverHv: 1.5, returnOnRisk: 0.1, pop: 80, legSpread: 5, distance: 1 } };
}

export const run = (today: string, symbols: Record<string, SymbolInfo>, candidates: RankedCandidate[], generatedAt = `${today}T15:00:00Z`): RankedScan => ({
  schema: 'spread-scanner/scan@1', generatedAt, today, config: config(), universe: Object.keys(symbols).length, dropped: [], symbols, candidates,
  weights: { ivPercentile: 1, ivOverHv: 1, returnOnRisk: 1, pop: 1, legSpread: 1, distance: 0 },
});
