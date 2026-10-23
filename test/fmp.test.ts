import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_ROW_CAP, Fmp } from '../src/providers/fmp.ts';
import { fakeFetch, instantHttp, json } from './fakes.ts';

const rows = (n: number, date: string) => Array.from({ length: n }, (_, i) => ({ symbol: `S${i}`, date, epsEstimated: 1 }));

test('the calendar is parsed and the key is sent in the query', async () => {
  const { fetch, calls } = fakeFetch(() => json([{ symbol: 'AAPL', date: '2026-11-02', epsEstimated: 1.99 }, { symbol: 7, date: 'x' }]));
  const out = await new Fmp('KEY123', instantHttp(fetch)).earningsCalendar('2026-10-30', '2026-11-03');
  assert.deepEqual(out, [{ symbol: 'AAPL', date: '2026-11-02' }]);
  assert.match(calls[0]?.url ?? '', /earnings-calendar\?from=2026-10-30&to=2026-11-03&apikey=KEY123$/);
});

test('a range that hits the row cap was truncated, so it is split and fetched again', async () => {
  const asked: string[] = [];
  const { fetch } = fakeFetch((request) => {
    const from = /from=([\d-]+)/.exec(request.url)?.[1] as string;
    const to = /to=([\d-]+)/.exec(request.url)?.[1] as string;
    asked.push(`${from}..${to}`);
    return json(from === '2026-11-02' && to === '2026-11-05' ? rows(CALENDAR_ROW_CAP, from) : rows(3, from));
  });
  const out = await new Fmp('K', instantHttp(fetch)).earningsCalendar('2026-11-02', '2026-11-05');
  assert.deepEqual(asked, ['2026-11-02..2026-11-05', '2026-11-02..2026-11-03', '2026-11-04..2026-11-05']);
  assert.equal(out.length, 6);
});

test('one day that still reaches the cap is an error, not a silent gap', async () => {
  const { fetch } = fakeFetch(() => json(rows(CALENDAR_ROW_CAP, '2026-11-02')));
  await assert.rejects(new Fmp('K', instantHttp(fetch)).earningsCalendar('2026-11-02', '2026-11-02'), /cap/);
});

test('a failed call never puts the key in the error', async () => {
  const { fetch } = fakeFetch(() => new Response('', { status: 403 }));
  await assert.rejects(new Fmp('KEY123', instantHttp(fetch)).earningsCalendar('2026-11-02', '2026-11-03'), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.doesNotMatch(e.message, /KEY123|apikey/);
    return true;
  });
});

test('daily bars come back oldest first', async () => {
  const { fetch } = fakeFetch(() => json([{ date: '2026-10-22', close: 66 }, { date: '2026-10-20', close: 65.5 }, { date: '2026-10-21', close: '65.9' }, { date: '2026-10-19' }]));
  const bars = await new Fmp('K', instantHttp(fetch)).dailyBars('NFLX', '2026-10-19', '2026-10-22');
  assert.deepEqual(bars.map((b) => b.date), ['2026-10-20', '2026-10-21', '2026-10-22']);
  assert.equal(bars[1]?.close, 65.9);
});
