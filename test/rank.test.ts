import { test } from 'node:test';
import assert from 'node:assert/strict';
import { components, percentRanks, preScores, rankScan, weightedScore } from '../src/rank.ts';
import { blendedVolatility, historicalVolatility } from '../src/volatility.ts';
import { spreadMetrics } from '../src/spread.ts';
import type { Candidate, RankWeights, Ranks, ScanResult, SymbolInfo } from '../src/types.ts';
import { addDays } from '../src/dates.ts';
import { close, config, quote } from './fixtures.ts';

const weights = (over: Partial<RankWeights> = {}): RankWeights => ({ ivPercentile: 0, ivOverHv: 0, returnOnRisk: 0, pop: 0, legSpread: 0, distance: 0, ...over });

test('percent ranks: lowest 0, highest 1, ties share, nulls stay null, a lone value is 0.5', () => {
  assert.deepEqual(percentRanks([10, 30, 20]), [0, 1, 0.5]);
  assert.deepEqual(percentRanks([5, 5, 9]), [0.25, 0.25, 1]);
  assert.deepEqual(percentRanks([null, 3, 1]), [null, 1, 0]);
  assert.deepEqual(percentRanks([7]), [0.5]);
  assert.deepEqual(percentRanks([null, null]), [null, null]);
});

test('the score is the weighted average of the ranks that exist', () => {
  const ranks: Ranks = { ivPercentile: 1, ivOverHv: null, returnOnRisk: 0.5, pop: 0, legSpread: 1, distance: 0 };
  close(weightedScore(ranks, weights({ ivPercentile: 1, returnOnRisk: 1 })), 0.75);
  close(weightedScore(ranks, weights({ ivPercentile: 1, ivOverHv: 5, returnOnRisk: 1 })), 0.75, 1e-12); // a missing component drops out
  close(weightedScore(ranks, weights({ pop: 1, legSpread: 3 })), 0.75);
  assert.equal(weightedScore(ranks, weights({ ivOverHv: 1 })), 0.5, 'nothing to score on');
});

test('historical volatility: a known series, the calendar window, and too little data', () => {
  const bars = (n: number, step: number) => {
    let c = 100;
    return Array.from({ length: n }, (_, i) => ({ date: addDays('2026-06-01', i), close: (c *= i % 2 === 0 ? 1 + step : 1 / (1 + step)) }));
  };
  const hv = historicalVolatility(bars(120, 0.01), 30);
  assert.ok(hv !== null);
  // 30 returns of exactly +-1% (log 0.00995), mean zero; the sample deviation divides by n - 1
  close(hv, Math.log(1.01) * Math.sqrt(252) * Math.sqrt(30 / 29), 1e-9);
  assert.equal(historicalVolatility(bars(8, 0.01), 30), null, 'fewer than 10 returns');
  assert.equal(historicalVolatility([], 30), null);
  const flat = Array.from({ length: 40 }, (_, i) => ({ date: addDays('2026-06-01', i), close: 50 }));
  assert.equal(historicalVolatility(flat, 30), 0);
});

test('the blend averages whichever figures exist', () => {
  close(blendedVolatility({ hv30: 0.2, hv60: 0.3, hv90: 0.4 }) ?? NaN, 0.3);
  close(blendedVolatility({ hv30: null, hv60: 0.3, hv90: null }) ?? NaN, 0.3);
  assert.equal(blendedVolatility({ hv30: null, hv60: null, hv90: null }), null);
});

const info = (over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  spot: 100, isEtf: false, isIlliquid: false, sector: null, ivIndex: 0.3, ivRank: 0.5, ivPercentile: 0.5, hv30: 0.2, hv60: 0.2, hv90: 0.2,
  beta: 1, liquidityRating: 4, hvSource: 'tastytrade', reportDate: null, reportTimeOfDay: null,
  earnings: { ok: true, reason: 'clear', last: null, next: null, daysSinceLast: null, daysUntilNext: null }, ...over,
});

function candidate(symbol: string, shortBidAsk: [number, number], longBidAsk: [number, number], over: { shortStrike?: number; longStrike?: number } = {}): Candidate {
  const spread = spreadMetrics(
    quote('put', over.shortStrike ?? 90, shortBidAsk[0], shortBidAsk[1], -0.2),
    quote('put', over.longStrike ?? 85, longBidAsk[0], longBidAsk[1], -0.1),
  );
  assert.ok(spread);
  return { symbol, spread };
}

test('components: IV over realised vol, natural return on risk, worst leg spread, distance in expected moves', () => {
  const c = candidate('AAA', [1.0, 1.1], [0.4, 0.44]);
  const k = components(c, info());
  close(k.ivOverHv ?? NaN, 1.5);
  close(k.returnOnRisk, (1.0 - 0.44) / (5 - (1.0 - 0.44)), 1e-12); // sold at the bid, bought at the ask
  close(k.legSpread, Math.max((0.1 / 1.05) * 100, (0.04 / 0.42) * 100), 1e-9);
  close(k.distance, 10 / (100 * 0.3 * Math.sqrt(c.spread.dte / 365)), 1e-12);
  assert.equal(components(c, info({ hv30: null, hv60: null, hv90: null })).ivOverHv, null);
  assert.equal(components(c, info({ ivIndex: null })).distance, 0);
});

test('ranking: underlying-level figures are ranked across underlyings, so many spreads do not count many times', () => {
  const symbols = { RICH: info({ ivPercentile: 0.9 }), CHEAP: info({ ivPercentile: 0.2 }) };
  const result: ScanResult = {
    schema: 'spread-scanner/scan@1', generatedAt: '', today: '2026-10-23', config: config(), universe: 2, dropped: [], symbols,
    candidates: [
      ...[90, 89, 88, 87].map((k) => candidate('CHEAP', [1.0, 1.1], [0.4, 0.44], { shortStrike: k, longStrike: k - 5 })),
      candidate('RICH', [1.0, 1.1], [0.4, 0.44]),
    ],
  };
  const ranked = rankScan(result, weights({ ivPercentile: 1 }));
  assert.equal(ranked.candidates[0]?.symbol, 'RICH');
  assert.equal(ranked.candidates[0]?.ranks.ivPercentile, 1);
  assert.ok(ranked.candidates.slice(1).every((c) => c.symbol === 'CHEAP' && c.ranks.ivPercentile === 0), 'four CHEAP spreads share one rank, not four');
  assert.deepEqual(ranked.weights, weights({ ivPercentile: 1 }));
});

test('ranking: a tighter, better-paying spread outranks a worse one, and the order is best first', () => {
  const symbols = { AAA: info(), BBB: info() };
  const result: ScanResult = {
    schema: 'spread-scanner/scan@1', generatedAt: '', today: '2026-10-23', config: config(), universe: 2, dropped: [], symbols,
    candidates: [candidate('AAA', [0.9, 1.3], [0.4, 0.5]), candidate('BBB', [1.0, 1.04], [0.4, 0.42])],
  };
  const ranked = rankScan(result, weights({ returnOnRisk: 1, legSpread: 1 }));
  assert.deepEqual(ranked.candidates.map((c) => c.symbol), ['BBB', 'AAA']);
  assert.ok(ranked.candidates[0]!.score > ranked.candidates[1]!.score);
});

test('pre-scores: IV percentile and IV over realised vol decide, a name with no history is judged on the percentile alone', () => {
  const hv = { hv30: 0.2, hv60: 0.2, hv90: 0.2 };
  const none = { hv30: null, hv60: null, hv90: null };
  const w = weights({ ivPercentile: 1, ivOverHv: 1, pop: 9, returnOnRisk: 9 }); // the spread-level weights must not count
  const [rich, cheap, noHistory, thin] = preScores(
    [
      { ivIndex: 0.5, ivPercentile: 0.9, ...hv },
      { ivIndex: 0.22, ivPercentile: 0.1, ...hv },
      { ivIndex: 0.4, ivPercentile: 0.5, ...none },
      { ivIndex: 0.3, ivPercentile: null, ...hv },
    ],
    w,
  ) as [number, number, number, number];
  assert.ok(rich > noHistory && noHistory > cheap, `${rich} ${noHistory} ${cheap}`);
  assert.equal(rich, 1, 'best on both');
  assert.equal(noHistory, 0.5, 'the middle percentile, and nothing else to count');
  assert.ok(thin > 0 && thin < 1, 'a missing percentile drops out; it is scored on IV over vol alone');
  assert.deepEqual(preScores([], w), []);
});
