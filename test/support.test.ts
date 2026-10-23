import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCache, noCache } from '../src/cache.ts';
import { loadCredentials, parseEnvFile } from '../src/credentials.ts';
import { addDays, chunk, dateWindows, daysBetween, easternDate } from '../src/dates.ts';
import { readSymbols } from '../src/cli.ts';

test('the New York date, not the UTC one, across the evening session and the clock change', () => {
  assert.equal(easternDate(new Date('2026-10-24T01:30:00Z')), '2026-10-23'); // 21:30 EDT
  assert.equal(easternDate(new Date('2026-10-23T14:00:00Z')), '2026-10-23');
  assert.equal(easternDate(new Date('2026-11-02T04:59:00Z')), '2026-11-01'); // 23:59 EST, after the clocks went back
  assert.equal(easternDate(new Date('2026-11-02T05:00:00Z')), '2026-11-02');
});

test('date arithmetic across month and year ends', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-23', '2026-12-04'), 42);
});

test('windows tile a range with no gap and no overlap, and the last one is cut short', () => {
  const w = dateWindows('2026-10-20', '2026-11-28', 3);
  assert.equal(w[0]?.from, '2026-10-20');
  assert.equal(w.at(-1)?.to, '2026-11-28');
  for (let i = 1; i < w.length; i++) assert.equal(addDays((w[i - 1] as { to: string }).to, 1), (w[i] as { from: string }).from);
  assert.ok(w.every((x) => daysBetween(x.from, x.to) <= 2));
  assert.deepEqual(dateWindows('2026-10-20', '2026-10-20', 3), [{ from: '2026-10-20', to: '2026-10-20' }]);
});

test('chunking keeps order and sizes', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test('env files: comments, quotes and blank lines', () => {
  assert.deepEqual(parseEnvFile('# a comment\nA=1\n\nB = "two words"\nC=\'x\'\nbroken line\nD=a=b\n'), { A: '1', B: 'two words', C: 'x', D: 'a=b' });
});

test('credentials: the environment wins over the file, and a missing key is named but never a value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spread-scanner-test-'));
  try {
    const file = join(dir, 'c.env');
    writeFileSync(file, 'TT_CLIENT_SECRET=file-secret\nTT_REFRESH_TOKEN=file-token\nFMP_API_KEY=file-key\nTT_CLIENT_ID=cid\n');
    const c = loadCredentials(file, { TT_REFRESH_TOKEN: 'env-token' });
    assert.equal(c.tastytrade.refreshToken, 'env-token');
    assert.equal(c.tastytrade.clientSecret, 'file-secret');
    assert.equal(c.tastytrade.clientId, 'cid');
    assert.equal(c.fmp.apiKey, 'file-key');
    writeFileSync(file, 'TT_CLIENT_SECRET=file-secret\n');
    assert.throws(() => loadCredentials(file, {}), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /TT_REFRESH_TOKEN, FMP_API_KEY/);
      assert.doesNotMatch(e.message, /file-secret/);
      return true;
    });
    assert.throws(() => loadCredentials(join(dir, 'absent.env'), {}), /Missing TT_CLIENT_SECRET/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file cache serves a fresh entry, refetches a stale one, and treats a damaged file as a miss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spread-scanner-test-'));
  try {
    let clock = Date.now();
    const cache = new FileCache(dir, () => clock);
    let fetched = 0;
    const get = () => cache.getOrFetch('chain/AAPL x', 1000, async () => ({ n: ++fetched }));
    assert.deepEqual(await get(), { n: 1 });
    assert.deepEqual(await get(), { n: 1 }, 'fresh');
    clock += 5_000_000;
    assert.deepEqual(await get(), { n: 2 }, 'stale');
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file as string), '{not json');
    clock += 0;
    assert.deepEqual(await get(), { n: 3 }, 'damaged');
    assert.equal(readdirSync(dir).length, 1, 'no temporary files left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no cache always fetches', async () => {
  let n = 0;
  await noCache.getOrFetch('k', 1e9, async () => ++n);
  assert.equal(await noCache.getOrFetch('k', 1e9, async () => ++n), 2);
});

test('symbols from a list and a file: upper-cased, comments and blanks skipped, duplicates left for the scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spread-scanner-test-'));
  try {
    const file = join(dir, 'w.txt');
    writeFileSync(file, '# watchlist\naapl\n\nmsft, nflx  # trailing note\nBRK/B\n');
    assert.deepEqual(readSymbols('spy,qqq', file), ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NFLX', 'BRK/B']);
    assert.deepEqual(readSymbols(undefined, undefined), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
