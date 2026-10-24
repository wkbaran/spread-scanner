import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachOutcomes, blackScholes, drawNormals, normalCdf, pathVolatility, simulateManaged, tradingSchedule, type SimulationInput } from '../src/outcome.ts';
import type { Candidate, OutcomeConfig } from '../src/types.ts';
import { close, config } from './fixtures.ts';

const cfg = (over: Partial<OutcomeConfig> = {}): OutcomeConfig => ({ ...config().outcome, paths: 4000, ...over });
const normalsFor = (c: OutcomeConfig, days = 20) => drawNormals(c.paths, days * c.intraday);

// A bull put spread, 5 wide, 41 days out, priced at one volatility so the model agrees with the market.
const SIGMA = 0.3;
const RATE = 0.0;
const put = (strike: number) => blackScholes('put', 100, strike, SIGMA, 41 / 365, RATE);
const input = (over: Partial<SimulationInput> = {}): SimulationInput => {
  const credit = put(92) - put(87);
  return { side: 'put', spot: 100, shortStrike: 92, longStrike: 87, shortIv: SIGMA, longIv: SIGMA, dte: 41, creditMid: credit, creditNatural: credit - 0.1, pathSigma: SIGMA, rate: RATE, today: '2026-10-23', expiration: '2026-12-03', ...over };
};

test('the normal CDF and Black-Scholes agree with textbook values, and put-call parity holds', () => {
  close(normalCdf(0), 0.5, 1e-7);
  close(normalCdf(1.96), 0.975, 1e-4);
  close(normalCdf(-1), 0.158655, 1e-5);
  close(blackScholes('call', 100, 100, 0.2, 1, 0.05), 10.4506, 1e-3);
  const c = blackScholes('call', 95, 100, 0.25, 0.4, 0.03);
  const p = blackScholes('put', 95, 100, 0.25, 0.4, 0.03);
  close(c - p, 95 - 100 * Math.exp(-0.03 * 0.4), 1e-9);
  assert.equal(blackScholes('put', 90, 100, 0.2, 0, 0.03), 10, 'at expiry it is the intrinsic value');
});

test('trading days skip weekends, and each knows the calendar days since the one before', () => {
  // 2026-10-23 is a Friday
  assert.deepEqual(tradingSchedule('2026-10-23', '2026-10-28'), [
    { date: '2026-10-26', gapDays: 3, elapsedDays: 3 },
    { date: '2026-10-27', gapDays: 1, elapsedDays: 4 },
    { date: '2026-10-28', gapDays: 1, elapsedDays: 5 },
  ]);
  assert.equal(tradingSchedule('2026-10-23', '2026-10-23').length, 0);
});

test('the draws are antithetic, repeatable, and have mean 0 and variance 1', () => {
  const a = drawNormals(4000, 30);
  const b = drawNormals(4000, 30);
  assert.deepEqual(a[17], b[17]);
  assert.deepEqual(Array.from(a[1] as Float64Array), Array.from(a[0] as Float64Array).map((z) => -z));
  const all = a.flatMap((r) => Array.from(r));
  const mean = all.reduce((s, z) => s + z, 0) / all.length;
  const variance = all.reduce((s, z) => s + (z - mean) ** 2, 0) / all.length;
  close(mean, 0, 1e-9);
  close(variance, 1, 0.03);
});

test('with free fills at a fair price, nothing about when you leave creates an edge', () => {
  // Leaving only at the two ends of the range is a clean optional-stopping case: the expected result is zero.
  const symmetric = cfg({ takeProfit: 1, stopLoss: 1, fillShare: 0 });
  const o = simulateManaged(input(), symmetric, normalsFor(symmetric));
  assert.ok(Math.abs(o.ev) < 3.5, `EV $${o.ev.toFixed(2)}`);
  // A resting order fills at its price but a stop fills where the market is after the close, so early exits can
  // only cost a little to gaps, never add: the average is at most zero up to noise, and bounded below.
  for (const rules of [{ takeProfit: 0.5, stopLoss: 0.25 }, { takeProfit: 0.3, stopLoss: 0.6 }, { takeProfit: 0.8, stopLoss: 0.15 }]) {
    const c = cfg({ ...rules, fillShare: 0 });
    const r = simulateManaged(input(), c, normalsFor(c));
    assert.ok(r.ev < 3.5 && r.ev > -9, `EV $${r.ev.toFixed(2)} with ${JSON.stringify(rules)}`);
  }
});

test('the three ways out account for every path', () => {
  const c = cfg();
  const o = simulateManaged(input(), c, normalsFor(c));
  close(o.pTarget + o.pStop + o.pTime, 100, 1e-9);
  assert.ok(o.pTarget > 20 && o.pStop > 5 && o.pTime > 5, JSON.stringify(o));
  close(o.edge, o.winRate - o.breakEvenWinRate, 1e-9);
  // the break-even is the win rate at which the average win and the average loss cancel
  const be = o.breakEvenWinRate / 100;
  close(be * o.avgWin - (1 - be) * o.avgLoss, 0, 1e-6);
  assert.ok(o.breakEvenWinRate > 50, 'a small win against a large loss needs a high win rate: ' + o.breakEvenWinRate.toFixed(1));
  // EV is the win share of the average win less the loss share of the average loss
  close(o.ev, (o.winRate / 100) * o.avgWin - (1 - o.winRate / 100) * o.avgLoss, 1e-6);
});

test('costs come off the result: paying more of the bid-ask lowers the expected P&L', () => {
  const free = cfg({ fillShare: 0 });
  const worst = cfg({ fillShare: 1 });
  const a = simulateManaged(input(), free, normalsFor(free));
  const b = simulateManaged(input(), worst, normalsFor(worst));
  assert.ok(b.ev < a.ev - 5, `${a.ev.toFixed(1)} then ${b.ev.toFixed(1)}`);
});

test('a calmer stock than the options price helps the seller, and a wilder one hurts', () => {
  const c = cfg();
  const base = simulateManaged(input(), c, normalsFor(c));
  const calm = simulateManaged(input({ pathSigma: 0.2 }), c, normalsFor(c));
  const wild = simulateManaged(input({ pathSigma: 0.45 }), c, normalsFor(c));
  assert.ok(calm.winRate > base.winRate && calm.ev > base.ev);
  assert.ok(wild.winRate < base.winRate && wild.ev < base.ev);
});

test('volatility draining out of the options helps the seller: more targets, fewer time exits, a better result', () => {
  const flat = cfg({ ivDecay: 0 });
  const decaying = cfg({ ivDecay: 0.35 });
  const a = simulateManaged(input(), flat, normalsFor(flat));
  const b = simulateManaged(input(), decaying, normalsFor(decaying));
  assert.ok(b.pTarget > a.pTarget + 5 && b.pTime < a.pTime - 5 && b.ev > a.ev + 3, `${JSON.stringify(a)} then ${JSON.stringify(b)}`);
});

test('the same inputs give the same answer, and a tighter stop means more stop-outs', () => {
  const c = cfg();
  assert.deepEqual(simulateManaged(input(), c, normalsFor(c)), simulateManaged(input(), c, normalsFor(c)));
  const tight = cfg({ stopLoss: 0.1 });
  const loose = cfg({ stopLoss: 0.6 });
  assert.ok(simulateManaged(input(), tight, normalsFor(tight)).pStop > simulateManaged(input(), loose, normalsFor(loose)).pStop);
});

test('a call spread mirrors a put spread: the same numbers when the market is reflected', () => {
  const c = cfg({ fillShare: 0 });
  const callPrice = (strike: number) => blackScholes('call', 100, strike, SIGMA, 41 / 365, RATE);
  const credit = callPrice(108) - callPrice(113);
  const o = simulateManaged(input({ side: 'call', shortStrike: 108, longStrike: 113, creditMid: credit, creditNatural: credit }), c, normalsFor(c));
  assert.ok(Math.abs(o.ev) < 3.5);
  assert.ok(o.winRate > 50 && o.winRate < 95);
});

test('the path volatility moves from the option toward realised volatility by volEdge', () => {
  const hv = { hv30: 0.2, hv60: 0.2, hv90: 0.2 };
  assert.equal(pathVolatility(0.3, hv, 0), 0.3);
  close(pathVolatility(0.3, hv, 1), 0.2, 1e-12);
  close(pathVolatility(0.3, hv, 0.5), 0.25, 1e-12);
  assert.equal(pathVolatility(0.3, { hv30: null, hv60: null, hv90: null }, 1), 0.3, 'no history, nothing to move toward');
});

test('attaching outcomes fills candidates that have both volatilities and leaves the others alone', () => {
  const c = cfg({ paths: 400 });
  const credit = input().creditMid;
  const leg = (strike: number, iv: number) => ({ side: 'put' as const, strike, expiration: '2026-12-03', dte: 41, bid: 1, ask: 1.1, delta: -0.2, iv, openInterest: 1, volume: 1 });
  const spread = (shortIv: number) => ({ side: 'put' as const, expiration: '2026-12-03', dte: 41, short: leg(92, shortIv), long: leg(87, SIGMA), width: 5, creditMid: credit, creditNatural: credit - 0.1, maxRisk: 400, profitPct: 20, breakeven: 91, popPct: 80, slippagePct: 5 });
  const info = { spot: 100, hv30: null, hv60: null, hv90: null } as never;
  const withIv: Candidate = { symbol: 'AAA', spread: spread(SIGMA) };
  const without: Candidate = { symbol: 'AAA', spread: spread(0) };
  attachOutcomes([withIv, without], { AAA: info }, c, 0, '2026-10-23');
  assert.ok(withIv.outcome !== undefined && withIv.outcome.winRate > 0);
  assert.equal(without.outcome, undefined);
});
