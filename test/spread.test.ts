import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legSpreadPct, pairSpreads, spreadMetrics } from '../src/spread.ts';
import { close, config, quote } from './fixtures.ts';

test('the bid-ask percent is (ask - bid) over the mid, and OptionStrat\'s own formula gives the same', () => {
  const bid = 0.35;
  const ask = 0.7;
  close(legSpreadPct({ bid, ask }), 66.6666667, 1e-6); // OptionStrat's warning for a 0.35 x 0.70 option reads 67%
  close(legSpreadPct({ bid, ask }), ((ask - bid) / ((ask - bid) / 2 + bid)) * 100);
  close(legSpreadPct({ bid: 0.52, ask: 0.56 }), 7.4074074, 1e-6);
});

test('an option with no bid, or a crossed quote, never passes', () => {
  assert.equal(legSpreadPct({ bid: 0, ask: 0.1 }), Infinity);
  assert.equal(legSpreadPct({ bid: 0.5, ask: 0.4 }), Infinity);
});

test('put spread metrics, on the SPY 760/765 example', () => {
  const short = quote('put', 765, 7.51, 7.54, -0.339);
  const long = quote('put', 760, 6.45, 6.47, -0.293);
  const s = spreadMetrics(short, long);
  assert.ok(s);
  close(s.width, 5);
  close(s.creditMid, 1.065);
  close(s.creditNatural, 1.04);
  close(s.maxRisk, 393.5);
  close(s.profitPct, (1.065 / 3.935) * 100, 1e-9);
  close(s.breakeven, 763.935);
  close(s.popPct, 67.08, 0.01); // OptionStrat showed 67% for this spread
  close(s.slippagePct, (0.025 / 1.065) * 100, 1e-9);
});

test('call spread metrics mirror the put case', () => {
  const short = quote('call', 100, 1.0, 1.1, 0.2);
  const long = quote('call', 105, 0.4, 0.5, 0.1);
  const s = spreadMetrics(short, long);
  assert.ok(s);
  close(s.creditMid, 0.6);
  close(s.breakeven, 100.6);
  close(s.popPct, (1 - (0.2 + (0.1 - 0.2) * (0.6 / 5))) * 100, 1e-9);
});

test('a pair that is not a credit at the mid is dropped', () => {
  assert.equal(spreadMetrics(quote('put', 90, 0.4, 0.5, -0.1), quote('put', 85, 1.0, 1.1, -0.2)), null);
});

const spot = 100;
const chain = () => [
  quote('put', 90, 1.0, 1.1, -0.2),
  quote('put', 86, 0.5, 0.55, -0.12), // width 4: too narrow
  quote('put', 85, 0.45, 0.5, -0.11), // width 5
  quote('put', 84, 0.38, 0.42, -0.09), // width 6
  quote('put', 82, 0.3, 0.33, -0.07), // width 8
  quote('put', 80, 0.2, 0.24, -0.05), // width 10
  quote('put', 79, 0.15, 0.18, -0.04), // width 11: too wide
];

test('every usable long leg from the minimum to the maximum width becomes a spread', () => {
  const found = pairSpreads(chain(), 'put', spot, config());
  assert.deepEqual(found.map((s) => s.width), [5, 6, 8, 10]);
  assert.ok(found.every((s) => s.short.strike === 90));
});

test('the width bounds are inclusive and come from the config', () => {
  assert.deepEqual(pairSpreads(chain(), 'put', spot, config({ width: { min: 6, max: 8 } })).map((s) => s.width), [6, 8]);
  assert.deepEqual(pairSpreads(chain(), 'put', spot, config({ width: { min: 5, max: 5 } })).map((s) => s.width), [5]);
});

test('a long leg with too wide a bid-ask is skipped, the other widths remain', () => {
  const quotes = chain().map((q) => (q.strike === 85 ? { ...q, bid: 0.1, ask: 0.3 } : q));
  assert.deepEqual(pairSpreads(quotes, 'put', spot, config()).map((s) => s.width), [6, 8, 10]);
});

test('a short leg must be out of the money, in the delta range, in the DTE window and tight enough', () => {
  const cfg = config();
  const base = chain();
  assert.equal(pairSpreads([quote('put', 105, 6.0, 6.1, -0.2), quote('put', 100, 3.0, 3.1, -0.1)], 'put', spot, cfg).length, 0, 'in the money');
  assert.equal(pairSpreads([quote('put', 95, 2.0, 2.1, -0.35), ...base.slice(2)], 'put', spot, cfg).length, 0, 'delta too high');
  assert.equal(pairSpreads(base.map((q) => ({ ...q, dte: 20 })), 'put', spot, cfg).length, 0, 'inside the DTE window');
  const wide = base.map((q) => (q.strike === 90 ? { ...q, bid: 0.7, ask: 1.1 } : q));
  assert.equal(pairSpreads(wide, 'put', spot, cfg).length, 0, 'short leg bid-ask over 20%');
});

test('call spreads pair upward, and expirations are judged separately', () => {
  const calls = [quote('call', 110, 1.0, 1.1, 0.2), quote('call', 115, 0.45, 0.5, 0.11), quote('call', 120, 0.2, 0.24, 0.05)];
  assert.deepEqual(pairSpreads(calls, 'call', spot, config()).map((s) => s.width), [5, 10]);
  const later = chain().map((q) => ({ ...q, expiration: '2026-12-11', dte: 44 }));
  const found = pairSpreads([...chain(), ...later], 'put', spot, config());
  assert.deepEqual([...new Set(found.map((s) => s.expiration))], ['2026-12-04', '2026-12-11']);
});

test('a long leg on the wrong side of the short is never paired', () => {
  const quotes = [quote('put', 90, 1.0, 1.1, -0.2), quote('put', 95, 2.0, 2.1, -0.3)];
  assert.equal(pairSpreads(quotes, 'put', spot, config()).length, 0);
});
