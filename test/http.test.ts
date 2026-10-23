import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http, HttpError } from '../src/http.ts';
import { fakeFetch, instantHttp, json } from './fakes.ts';

test('a 503 is retried and the next answer is used', async () => {
  let n = 0;
  const { fetch, calls } = fakeFetch(() => (++n < 3 ? new Response('', { status: 503 }) : json({ ok: true })));
  assert.deepEqual(await instantHttp(fetch).json('https://example.test/a'), { ok: true });
  assert.equal(calls.length, 3);
});

test('a 429 waits for Retry-After, in seconds', async () => {
  const slept: number[] = [];
  let n = 0;
  const { fetch } = fakeFetch(() => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : json({})));
  const http = new Http({ userAgent: 't/1', fetch, minIntervalMs: 0, sleep: async (ms) => void slept.push(ms) });
  await http.json('https://example.test/a');
  assert.deepEqual(slept, [2000]);
});

test('it gives up after the attempt limit with the last status', async () => {
  const { fetch, calls } = fakeFetch(() => new Response('', { status: 500 }));
  await assert.rejects(instantHttp(fetch, { maxAttempts: 3 }).json('https://example.test/a'), (e: unknown) => e instanceof HttpError && e.status === 500);
  assert.equal(calls.length, 3);
});

test('a 404 is not retried', async () => {
  const { fetch, calls } = fakeFetch(() => new Response('', { status: 404 }));
  await assert.rejects(instantHttp(fetch).json('https://example.test/a'), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(calls.length, 1);
});

test('a network error is retried, then reported without detail', async () => {
  const { fetch, calls } = fakeFetch(() => {
    throw new TypeError('connect ECONNREFUSED secret-host');
  });
  await assert.rejects(instantHttp(fetch, { maxAttempts: 2 }).json('https://example.test/a?apikey=SECRET'), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.doesNotMatch(e.message, /SECRET|secret-host/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('an error never carries the query string, which can hold an API key', async () => {
  const { fetch } = fakeFetch(() => new Response('{"error":"bad key SECRET"}', { status: 401 }));
  await assert.rejects(instantHttp(fetch).json('https://example.test/path?apikey=SECRET'), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.doesNotMatch(e.message, /SECRET|apikey/);
    assert.equal(e.where, 'https://example.test/path');
    return true;
  });
});

test('requests are spaced by the minimum interval, and carry the user agent', async () => {
  let clock = 1000;
  const slept: number[] = [];
  const { fetch, calls } = fakeFetch(() => json({}));
  const http = new Http({ userAgent: 'agent/9', fetch, minIntervalMs: 300, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  await http.json('https://example.test/a');
  clock += 100;
  await http.json('https://example.test/b');
  assert.deepEqual(slept, [200]); // the first needs no wait; the second starts 100 ms after, so waits the other 200
  assert.equal(calls[0]?.headers['User-Agent'], 'agent/9');
});
