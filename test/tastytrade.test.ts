import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tastytrade, parseOcc } from '../src/providers/tastytrade.ts';
import { HttpError } from '../src/http.ts';
import { fakeFetch, instantHttp, json, occ } from './fakes.ts';
import { close } from './fixtures.ts';

const credentials = { clientSecret: 'CLIENT-SECRET', refreshToken: 'REFRESH-TOKEN' };

/** An API that hands out tokens and answers each path from `routes`. */
function api(routes: (path: string) => unknown, onToken?: () => void) {
  return fakeFetch((request) => {
    if (request.url.endsWith('/oauth/token')) {
      onToken?.();
      return json({ access_token: `token-${request.body?.length ?? 0}`, expires_in: 900 });
    }
    return json(routes(request.url.replace('https://api.tastyworks.com', '')));
  });
}

test('an OCC symbol gives its expiration, side and strike', () => {
  assert.deepEqual(parseOcc('NFLX  261120P00061000'), { expiration: '2026-11-20', side: 'put', strike: 61 });
  assert.deepEqual(parseOcc('SPY   261120C00762500'), { expiration: '2026-11-20', side: 'call', strike: 762.5 });
  assert.equal(parseOcc('not an option'), null);
});

test('one token serves many calls, and the secrets travel only in the token request', async () => {
  let tokens = 0;
  const { fetch, calls } = api(() => ({ data: { items: [] } }), () => tokens++);
  const tt = new Tastytrade(credentials, instantHttp(fetch));
  await tt.equityQuotes(['AAPL']);
  await tt.instruments(['AAPL']);
  await tt.metrics(['AAPL']);
  assert.equal(tokens, 1);
  const body = calls.find((c) => c.url.endsWith('/oauth/token'))?.body ?? '';
  assert.match(body, /refresh_token/);
  assert.ok(calls.filter((c) => !c.url.endsWith('/oauth/token')).every((c) => c.headers['Authorization']?.startsWith('Bearer token-')));
  assert.ok(calls.filter((c) => !c.url.endsWith('/oauth/token')).every((c) => !c.url.includes('SECRET') && !c.url.includes('REFRESH')));
});

test('a 401 gets one fresh token and a second try, and a second 401 is an error', async () => {
  let tokens = 0;
  let n = 0;
  const { fetch } = fakeFetch((request) => {
    if (request.url.endsWith('/oauth/token')) return json({ access_token: `t${++tokens}` });
    return ++n === 1 ? new Response('', { status: 401 }) : json({ data: { items: [] } });
  });
  await new Tastytrade(credentials, instantHttp(fetch)).equityQuotes(['AAPL']);
  assert.equal(tokens, 2);

  const always = fakeFetch((request) => (request.url.endsWith('/oauth/token') ? json({ access_token: 'x' }) : new Response('', { status: 401 })));
  await assert.rejects(new Tastytrade(credentials, instantHttp(always.fetch)).equityQuotes(['AAPL']), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.doesNotMatch(e.message, /SECRET|REFRESH/);
    return true;
  });
});

test('metrics: fractions stay fractions, percent figures become fractions, and the report date is kept as held', async () => {
  const { fetch } = api(() => ({
    data: {
      items: [
        {
          symbol: 'AAPL',
          'implied-volatility-index': '0.287435578',
          'implied-volatility-index-rank': '0.57672264',
          'implied-volatility-percentile': '0.620858249',
          'implied-volatility-30-day': '29.06',
          'historical-volatility-30-day': '16.57',
          'historical-volatility-60-day': '18.81',
          'historical-volatility-90-day': '24.83',
          beta: '1.07309587',
          'liquidity-rating': 4,
          sector: 'Technology',
          earnings: { 'expected-report-date': '2026-11-02', 'time-of-day': 'AMC' },
        },
        { symbol: 'THIN', 'implied-volatility-index': null, earnings: null },
      ],
    },
  }));
  const m = await new Tastytrade(credentials, instantHttp(fetch)).metrics(['AAPL', 'THIN']);
  const a = m.get('AAPL');
  assert.equal(a?.ivIndex, 0.287435578);
  assert.equal(a?.ivPercentile, 0.620858249);
  close(a?.hv30 ?? NaN, 0.1657, 1e-12);
  close(a?.hv90 ?? NaN, 0.2483, 1e-12);
  assert.equal(a?.liquidityRating, 4);
  assert.equal(a?.reportDate, '2026-11-02');
  assert.equal(a?.reportTimeOfDay, 'AMC');
  const thin = m.get('THIN');
  assert.equal(thin?.ivIndex, null);
  assert.equal(thin?.hv30, null);
  assert.equal(thin?.reportDate, null);
});

test('metrics are requested 500 symbols at a time, and slashes are encoded', async () => {
  const { fetch, calls } = api(() => ({ data: { items: [] } }));
  const symbols = Array.from({ length: 1001 }, (_, i) => `S${i}`);
  symbols[0] = 'BRK/B';
  await new Tastytrade(credentials, instantHttp(fetch)).metrics(symbols);
  const metricCalls = calls.filter((c) => c.url.includes('/market-metrics'));
  assert.equal(metricCalls.length, 3);
  assert.ok(metricCalls[0]?.url.includes('BRK%2FB'));
});

test('instrument flags', async () => {
  const { fetch, calls } = api(() => ({
    data: { items: [
      { symbol: 'KRE', 'is-etf': true, 'is-index': false, 'is-illiquid': false, 'is-options-closing-only': false, active: true },
      { symbol: 'XYZ', 'is-etf': false, 'is-illiquid': true, 'is-options-closing-only': true, active: false },
    ] },
  }));
  const flags = await new Tastytrade(credentials, instantHttp(fetch)).instruments(['KRE', 'XYZ']);
  assert.deepEqual(flags.get('KRE'), { isEtf: true, isIndex: false, isIlliquid: false, optionsClosingOnly: false, active: true });
  assert.deepEqual(flags.get('XYZ'), { isEtf: false, isIndex: false, isIlliquid: true, optionsClosingOnly: true, active: false });
  assert.ok(calls.some((c) => c.url.includes('symbol[]=KRE&symbol[]=XYZ')));
});

test('the chain listing keeps standard contracts only, from every expiration type', async () => {
  const { fetch } = api(() => ({
    data: { items: [
      { 'option-chain-type': 'Standard', 'expiration-type': 'Weekly', symbols: [occ('NFLX', '2026-10-30', 'put', 61)] },
      { 'option-chain-type': 'Standard', 'expiration-type': 'Regular', symbols: [occ('NFLX', '2026-11-20', 'call', 70), occ('NFLX', '2026-11-20', 'put', 70)] },
      { 'option-chain-type': 'Non-standard', 'expiration-type': 'Regular', symbols: [occ('NFLX1', '2026-11-20', 'put', 61)] },
    ] },
  }));
  const listing = await new Tastytrade(credentials, instantHttp(fetch)).chainListing('NFLX');
  assert.equal(listing.length, 3);
  assert.deepEqual(listing[0], { occ: 'NFLX  261030P00061000', expiration: '2026-10-30', side: 'put', strike: 61 });
});

test('option quotes: 100 a request, spaces encoded, fields parsed, incomplete quotes left out', async () => {
  const requested: string[][] = [];
  const { fetch, calls } = api((path) => {
    const list = decodeURIComponent(path.split('equity-option=')[1] ?? '').split(',');
    requested.push(list);
    return { data: { items: list.map((symbol, i) => (i === 0
      ? { symbol, bid: null, ask: '1.0', delta: '-0.2' } // no bid: unusable
      : { symbol, bid: '0.52', ask: '0.56', delta: '-0.174708982', volatility: '0.3157', 'open-interest': 749, volume: '138.0' })) } };
  });
  const symbols = Array.from({ length: 230 }, (_, i) => occ('NFLX', '2026-11-20', 'put', 20 + i / 10));
  const quotes = await new Tastytrade(credentials, instantHttp(fetch)).optionQuotes(symbols);
  assert.deepEqual(requested.map((r) => r.length), [100, 100, 30]);
  assert.ok(calls.some((c) => c.url.includes('NFLX%20%20261120P')));
  assert.equal(quotes.size, 227); // the first symbol of each batch had no bid
  const q = quotes.get(symbols[1] as string);
  assert.deepEqual(q, { bid: 0.52, ask: 0.56, delta: -0.174708982, iv: 0.3157, openInterest: 749, volume: 138 });
});
