import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cache } from '../src/cache.ts';
import { addDays, daysBetween } from '../src/dates.ts';
import type { InstrumentFlags, ListedContract, OptionQuoteData, SymbolMetrics } from '../src/providers/tastytrade.ts';
import { parseOcc } from '../src/providers/tastytrade.ts';
import { scan, type FmpLike, type TastytradeLike } from '../src/scan.ts';
import { summarize } from '../src/format.ts';
import { blackScholes, occ } from './fakes.ts';
import { config } from './fixtures.ts';

const now = new Date('2026-10-23T18:00:00Z'); // 14:00 in New York
const today = '2026-10-23';
const expiration = addDays(today, 40);

interface Fake {
  spot?: number;
  iv?: number | null;
  etf?: boolean;
  reportDate?: string | null;
  noMetrics?: boolean;
  noQuote?: boolean;
}

const market: Record<string, Fake> = {
  AAA: { reportDate: '2026-12-20' }, // next report 58 days out
  BBB: { reportDate: '2026-12-20' }, // the calendar will say it reports in 10 days
  CCC: { reportDate: '2026-10-21' }, // reported two days ago
  JUST: { reportDate: '2026-10-01' }, // reported three weeks ago, no next date on file
  FUND: { etf: true, reportDate: null },
  WILD: { iv: 5 },
  NOIV: { iv: null },
  GHOST: { noMetrics: true },
  NOQUOTE: { reportDate: '2026-12-20', noQuote: true },
};

function build() {
  const log = { metrics: 0, listings: [] as string[], quoted: [] as string[][], equity: [] as string[][] };
  const spotOf = (symbol: string): number => market[symbol]?.spot ?? 100;
  const tt: TastytradeLike = {
    async metrics(symbols) {
      log.metrics++;
      const out = new Map<string, SymbolMetrics>();
      for (const s of symbols) {
        const m = market[s];
        if (m === undefined || m.noMetrics === true) continue;
        out.set(s, {
          symbol: s, ivIndex: m.iv === undefined ? 0.3 : m.iv, ivRank: 0.5, ivPercentile: 0.6, hv30: 0.2, hv60: 0.22, hv90: 0.25,
          beta: 1, liquidityRating: 4, sector: 'Tech', reportDate: m.reportDate ?? null, reportTimeOfDay: 'AMC',
        });
      }
      return out;
    },
    async instruments(symbols) {
      const out = new Map<string, InstrumentFlags>();
      for (const s of symbols) out.set(s, { isEtf: market[s]?.etf === true, isIndex: false, isIlliquid: false, optionsClosingOnly: false, active: true });
      return out;
    },
    async equityQuotes(symbols) {
      log.equity.push(symbols);
      return new Map(symbols.filter((s) => market[s]?.noQuote !== true).map((s) => [s, { mark: spotOf(s) }] as const));
    },
    async chainListing(symbol) {
      log.listings.push(symbol);
      const out: ListedContract[] = [];
      for (let strike = 60; strike <= 140; strike++) {
        for (const side of ['put', 'call'] as const) out.push({ occ: occ(symbol, expiration, side, strike), strike, side, expiration });
      }
      return out;
    },
    async optionQuotes(occs) {
      log.quoted.push(occs);
      const out = new Map<string, OptionQuoteData>();
      for (const o of occs) {
        const p = parseOcc(o);
        if (p === null) continue;
        const symbol = o.slice(0, 6).trim();
        const { price, delta } = blackScholes(p.side, spotOf(symbol), p.strike, 0.3, daysBetween(today, expiration) / 365);
        out.set(o, { bid: Math.max(0.01, Math.round((price - 0.02) * 100) / 100), ask: Math.round((price + 0.02) * 100) / 100, delta, iv: 0.3, openInterest: 1000, volume: 50 });
      }
      return out;
    },
  };
  const calendarCalls: string[] = [];
  const fmp: FmpLike = {
    async earningsCalendar(from, to) {
      calendarCalls.push(`${from}..${to}`);
      return from <= '2026-11-02' && '2026-11-02' <= to ? [{ symbol: 'BBB', date: '2026-11-02' }] : [];
    },
  };
  return { tt, fmp, log, calendarCalls };
}

class MemoryCache implements Cache {
  readonly store = new Map<string, unknown>();
  async getOrFetch<T>(key: string, _ttlMs: number, fetch: () => Promise<T>): Promise<T> {
    if (!this.store.has(key)) this.store.set(key, await fetch());
    return this.store.get(key) as T;
  }
}

const dropped = (result: Awaited<ReturnType<typeof scan>>, reason: string): string[] => result.dropped.find((d) => d.reason === reason)?.symbols ?? [];

test('the pipeline keeps the names that qualify and says why it dropped each of the others', async () => {
  const { tt, fmp } = build();
  const result = await scan(Object.keys(market), config(), { tt, fmp, cache: new MemoryCache(), now });
  assert.equal(result.schema, 'spread-scanner/scan@1');
  assert.equal(result.today, today);
  assert.equal(result.universe, Object.keys(market).length);
  assert.deepEqual(Object.keys(result.symbols).sort(), ['AAA', 'FUND', 'JUST']);
  assert.deepEqual(dropped(result, 'no metrics from tastytrade'), ['GHOST']);
  assert.deepEqual(dropped(result, 'earnings: reports too soon'), ['BBB']);
  assert.deepEqual(dropped(result, 'earnings: reported too recently'), ['CCC']);
  assert.deepEqual(dropped(result, 'implausible IV index'), ['WILD']);
  assert.deepEqual(dropped(result, 'no IV index'), ['NOIV']);
  assert.deepEqual(dropped(result, 'no stock quote'), ['NOQUOTE']);
  assert.equal(result.symbols['FUND']?.earnings.reason, 'fund, no earnings');
  assert.equal(result.symbols['JUST']?.earnings.reason, 'no report inside the window');
  assert.equal(result.symbols['AAA']?.spot, 100);
  assert.equal(result.symbols['AAA']?.ivPercentile, 0.6);
});

test('the candidates are real credit spreads inside every configured limit', async () => {
  const { tt, fmp } = build();
  const cfg = config();
  const result = await scan(['AAA'], cfg, { tt, fmp, cache: new MemoryCache(), now });
  assert.ok(result.candidates.length > 0);
  for (const { symbol, spread: s } of result.candidates) {
    assert.equal(symbol, 'AAA');
    assert.equal(s.expiration, expiration);
    assert.ok(s.width >= cfg.width.min && s.width <= cfg.width.max);
    assert.ok(Math.abs(s.short.delta) >= cfg.delta.min && Math.abs(s.short.delta) <= cfg.delta.max);
    assert.ok(s.creditMid > 0 && s.maxRisk > 0 && s.popPct > 50 && s.popPct < 100);
    assert.ok(s.side === 'put' ? s.short.strike < 100 && s.long.strike < s.short.strike : s.short.strike > 100 && s.long.strike > s.short.strike);
  }
  assert.ok(new Set(result.candidates.map((c) => c.spread.side)).size === 2, 'both puts and calls');
  assert.ok(new Set(result.candidates.map((c) => c.spread.width)).size > 1, 'more than one width is offered');
});

test('only a narrow band of each chain is quoted, in one request set for all the names', async () => {
  const { tt, fmp, log } = build();
  await scan(['AAA', 'FUND', 'JUST'], config(), { tt, fmp, cache: new MemoryCache(), now });
  assert.equal(log.quoted.length, 1, 'one optionQuotes call; the provider does the batching');
  const all = log.quoted[0] as string[];
  const chainSize = 81 * 2;
  assert.ok(all.length < 3 * chainSize * 0.5, `${all.length} contracts for three names whose chains hold ${3 * chainSize}`);
  assert.equal(log.equity.length, 1);
});

test('chain listings and calendar windows are cached, so a second scan fetches neither again', async () => {
  const { tt, fmp, log, calendarCalls } = build();
  const cache = new MemoryCache();
  await scan(['AAA', 'JUST'], config(), { tt, fmp, cache, now });
  assert.equal(calendarCalls.length, 14, '40 days in 3-day windows');
  await scan(['AAA', 'JUST'], config(), { tt, fmp, cache, now });
  assert.equal(calendarCalls.length, 14);
  assert.deepEqual(log.listings.sort(), ['AAA', 'JUST'], 'each listing fetched once');
});

test('when the calendar cannot be fetched, an unknown date fails but a fund still passes', async () => {
  const { tt } = build();
  const broken: FmpLike = { earningsCalendar: async () => { throw new Error('boom'); } };
  const messages: string[] = [];
  const result = await scan(['AAA', 'FUND', 'JUST'], config(), { tt, fmp: broken, cache: new MemoryCache(), now, log: (m) => messages.push(m) });
  assert.deepEqual(Object.keys(result.symbols), ['FUND']);
  assert.deepEqual(dropped(result, 'earnings: no report date known').sort(), ['AAA', 'JUST']);
  assert.ok(messages.some((m) => m.includes('earnings calendar unavailable')));
});

test('a name with no expiration in the window is reported as such', async () => {
  const { tt, fmp } = build();
  const result = await scan(['AAA'], config({ dte: { min: 90, max: 100 } }), { tt, fmp, cache: new MemoryCache(), now });
  assert.deepEqual(dropped(result, 'no expiration in the DTE window'), ['AAA']);
  assert.equal(result.candidates.length, 0);
});

test('duplicates and case are folded, and the text summary names the drops and lists spreads', async () => {
  const { tt, fmp } = build();
  const result = await scan(['aaa', 'AAA', ' bbb '], config(), { tt, fmp, cache: new MemoryCache(), now });
  assert.equal(result.universe, 2);
  const text = summarize(result, 5);
  assert.match(text, /2 symbols on 2026-10-23/);
  assert.match(text, /earnings: reports too soon/);
  assert.match(text, /SYMBOL/);
  assert.match(text, /more in the output file/);
});
