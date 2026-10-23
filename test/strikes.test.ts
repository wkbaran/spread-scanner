import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedMove, normalInverse, shortStrikeBand, strikeAtDelta, strikesToQuote } from '../src/strikes.ts';
import { close, config } from './fixtures.ts';

// Standard normal CDF, Abramowitz and Stegun 7.1.26 (error under 1.5e-7). Only the test needs it.
function cdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + Math.sign(x) * erf);
}

/** Black-Scholes absolute delta of an out-of-the-money option, to check the mapping against. */
function bsAbsDelta(side: 'put' | 'call', spot: number, strike: number, sigma: number, years: number, rate: number): number {
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * years) / (sigma * Math.sqrt(years));
  return side === 'call' ? cdf(d1) : cdf(-d1);
}

test('the inverse normal agrees with known values and is odd around one half', () => {
  close(normalInverse(0.5), 0, 1e-9);
  close(normalInverse(0.975), 1.959964, 1e-5);
  close(normalInverse(0.2), -normalInverse(0.8), 1e-9);
  close(normalInverse(0.01), -2.326348, 1e-5);
  assert.throws(() => normalInverse(0), RangeError);
  assert.throws(() => normalInverse(1), RangeError);
});

test('the strike found for a delta really has that delta, for puts and calls', () => {
  const base = { spot: 100, sigma: 0.3, years: 38 / 365, rate: 0.04 };
  for (const side of ['put', 'call'] as const) {
    for (const delta of [0.1, 0.15, 0.2, 0.25, 0.3]) {
      const strike = strikeAtDelta({ ...base, side, delta });
      close(bsAbsDelta(side, base.spot, strike, base.sigma, base.years, base.rate), delta, 1e-4);
    }
  }
});

test('a smaller delta sits further out of the money, below spot for puts and above for calls', () => {
  const base = { spot: 66, sigma: 0.33, years: 28 / 365, rate: 0.04 };
  const put = (delta: number) => strikeAtDelta({ ...base, side: 'put', delta });
  const call = (delta: number) => strikeAtDelta({ ...base, side: 'call', delta });
  assert.ok(put(0.15) < put(0.25) && put(0.25) < base.spot);
  assert.ok(call(0.15) > call(0.25) && call(0.25) > base.spot);
});

test('the short strike band brackets the strike at the middle of the delta range', () => {
  const cfg = config();
  const input = { spot: 66, sigma: 0.33, years: 28 / 365, rate: 0.04 };
  for (const side of ['put', 'call'] as const) {
    const { low, high } = shortStrikeBand(input, side, cfg);
    const middle = strikeAtDelta({ ...input, side, delta: 0.2 });
    assert.ok(low < middle && middle < high, `${side}: ${low} < ${middle} < ${high}`);
  }
});

test('strikes to quote: a few short strikes plus the legs a width away, nothing near the money or far out', () => {
  const cfg = config();
  const input = { spot: 66, sigma: 0.33, years: 28 / 365, rate: 0.04 };
  const grid = Array.from({ length: 61 }, (_, i) => 40 + i); // $1 strikes from 40 to 100
  const puts = strikesToQuote(grid, input, 'put', cfg);
  const middle = strikeAtDelta({ ...input, side: 'put', delta: 0.2 });
  assert.ok(puts.some((k) => Math.abs(k - middle) <= 1), 'a strike next to the 0.20-delta strike');
  assert.ok(puts.some((k) => Math.abs(k - (middle - 5)) <= 1.5), 'and a leg five below it');
  assert.ok(Math.max(...puts) < input.spot, 'no put at or above the money');
  assert.ok(puts.length < 30, `${puts.length} strikes is far fewer than the 60 listed`);
  const calls = strikesToQuote(grid, input, 'call', cfg);
  assert.ok(Math.min(...calls) > input.spot, 'no call at or below the money');
});

test('a wider width range quotes more strikes', () => {
  const input = { spot: 200, sigma: 0.4, years: 40 / 365, rate: 0.04 };
  const grid = Array.from({ length: 80 }, (_, i) => 120 + i * 2.5);
  const narrow = strikesToQuote(grid, input, 'put', config({ width: { min: 5, max: 5 } }));
  const wide = strikesToQuote(grid, input, 'put', config({ width: { min: 5, max: 10 } }));
  assert.ok(wide.length > narrow.length);
  assert.ok(narrow.every((k) => wide.includes(k)));
});

test('an expected move is spot x sigma x sqrt(years)', () => {
  close(expectedMove({ spot: 100, sigma: 0.2, years: 0.25 }), 100 * 0.2 * 0.5);
});
