import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cache } from '../src/cache.ts';
import { NyFed } from '../src/providers/nyfed.ts';
import { resolveRate } from '../src/rate.ts';
import { scan } from '../src/scan.ts';
import { fakeFetch, instantHttp, json } from './fakes.ts';
import { config } from './fixtures.ts';

const reply = (over: Record<string, unknown> = {}) => ({ refRates: [{ effectiveDate: '2026-10-22', type: 'SOFR', percentRate: 3.9, percentPercentile1: 3.83, volumeInBillions: 2945, revisionIndicator: '', ...over }] });

class MemoryCache implements Cache {
  readonly store = new Map<string, unknown>();
  async getOrFetch<T>(key: string, _ttlMs: number, fetch: () => Promise<T>): Promise<T> {
    if (!this.store.has(key)) this.store.set(key, await fetch());
    return this.store.get(key) as T;
  }
}

const withSofr = (on: boolean) => config({ strikeSelection: { ...config().strikeSelection, rate: 0.04, rateFromSofr: on } });

test('SOFR comes from the New York Fed as a fraction, with its date', async () => {
  const { fetch, calls } = fakeFetch(() => json(reply()));
  const sofr = await new NyFed(instantHttp(fetch)).sofr();
  assert.deepEqual(sofr, { rate: 0.039, date: '2026-10-22' });
  assert.equal(calls[0]?.url, 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json');
});

test('an answer that is not a SOFR rate is an error, not a zero', async () => {
  for (const body of [{ refRates: [] }, {}, reply({ type: 'EFFR' }), reply({ percentRate: 'n/a' }), reply({ effectiveDate: 20261022 })]) {
    const { fetch } = fakeFetch(() => json(body));
    await assert.rejects(new NyFed(instantHttp(fetch)).sofr(), /did not return a SOFR rate/);
  }
});

test('the rate is SOFR when asked for, cached for the day, and says where it came from', async () => {
  const cache = new MemoryCache();
  let fetched = 0;
  const get = async () => (fetched++, { rate: 0.0395, date: '2026-10-22' });
  assert.deepEqual(await resolveRate(withSofr(true), get, cache), { value: 0.0395, source: 'SOFR 2026-10-22' });
  await resolveRate(withSofr(true), get, cache);
  assert.equal(fetched, 1, 'one fetch a day, however many scans');
});

test('with the flag off the configured rate is used and nothing is fetched', async () => {
  let fetched = 0;
  const got = await resolveRate(withSofr(false), async () => (fetched++, { rate: 0.05, date: 'x' }), new MemoryCache());
  assert.deepEqual(got, { value: 0.04, source: 'config' });
  assert.equal(fetched, 0);
});

test('a failed or nonsensical SOFR never stops a scan: the configured rate is used and the log says so', async () => {
  const messages: string[] = [];
  const down = await resolveRate(withSofr(true), async () => { throw new Error('boom'); }, new MemoryCache(), (m) => messages.push(m));
  assert.deepEqual(down, { value: 0.04, source: 'config' });
  assert.match(messages[0] ?? '', /SOFR unavailable \(boom\).*4\.00%/);
  for (const bad of [3.9, -5, 0.5, Number.NaN]) {
    const got = await resolveRate(withSofr(true), async () => ({ rate: bad, date: 'x' }), new MemoryCache());
    assert.equal(got.source, 'config', `a rate of ${bad} is not believed`);
  }
});

test('a failed fetch is not cached, so the next scan tries again', async () => {
  const cache = new MemoryCache();
  await resolveRate(withSofr(true), async () => { throw new Error('boom'); }, cache);
  const got = await resolveRate(withSofr(true), async () => ({ rate: 0.039, date: '2026-10-22' }), cache);
  assert.equal(got.source, 'SOFR 2026-10-22');
});

test('the saved run records the rate it used', async () => {
  const result = await scan([], config(), { tt: { metrics: async () => new Map(), instruments: async () => new Map(), equityQuotes: async () => new Map(), chainListing: async () => [], optionQuotes: async () => new Map() }, fmp: { earningsCalendar: async () => [], dailyBars: async () => [] }, cache: new MemoryCache(), rateSource: 'SOFR 2026-10-22' });
  assert.deepEqual(result.rate, { value: 0.04, source: 'SOFR 2026-10-22' });
});
