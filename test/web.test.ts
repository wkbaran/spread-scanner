import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { weightedScore } from '../src/rank.ts';
import { DATA_MARKER, REPORT_ASSETS, jsonForScript, renderReport } from '../src/report.ts';
import type { RankWeights, Ranks, RankedCandidate, RankedScan } from '../src/types.ts';
import { close, config } from './fixtures.ts';
import { info, ranked, run } from './scans.ts';

const webPath = (name: string): string => fileURLToPath(new URL(`../web/${name}`, import.meta.url));

/** The page's model.js, run in a bare context the way a browser would run a classic script. */
function loadModel() {
  const context = vm.createContext({ btoa }); // a browser global the page's encoder uses
  vm.runInContext(readFileSync(webPath('model.js'), 'utf8'), context);
  return (context as { SpreadModel: Record<string, (...args: never[]) => unknown> & { WEIGHT_KEYS: string[]; RULER_EM: number } }).SpreadModel;
}
const M = loadModel() as any; // the page's untyped script: its shape is what these tests pin down
/** Arrays made inside the vm context have another Array prototype, so compare plain copies. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const KEYS: Array<keyof RankWeights> = ['ivPercentile', 'ivOverHv', 'returnOnRisk', 'pop', 'legSpread', 'distance'];

// A small deterministic generator, so a failure reproduces.
function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

test("the page scores exactly as src/rank.ts does, over many random ranks, weights and gaps", () => {
  const rnd = lcg(7);
  for (let i = 0; i < 500; i++) {
    const ranks = Object.fromEntries(KEYS.map((k) => [k, rnd() < 0.2 ? null : rnd()])) as Ranks;
    const weights = Object.fromEntries(KEYS.map((k) => [k, rnd() < 0.25 ? 0 : Math.round(rnd() * 100)])) as unknown as RankWeights;
    close(M.weightedScore(ranks, weights), weightedScore(ranks, weights), 1e-12);
  }
});

test("the page and the scan agree on what the weights are called", () => {
  assert.deepEqual(plain([...M.WEIGHT_KEYS]).sort(), Object.keys(config().ranking.weights).sort());
});

const scan = (): RankedScan => {
  const symbols = { AAA: info(0.3, { ivPercentile: 0.9 }), BBB: info(0.3, { isEtf: true, ivPercentile: 0.2 }) };
  const candidates: RankedCandidate[] = [
    { ...ranked('AAA', 0.9), ranks: { ...ranked('AAA', 0.9).ranks, ivPercentile: 1, pop: 0.2 } },
    { ...ranked('AAA', 0.6, { shortStrike: 88 }), ranks: { ...ranked('AAA', 0.6).ranks, ivPercentile: 1, pop: 0.9 } },
    { ...ranked('AAA', 0.5, { shortStrike: 86 }) },
    { ...ranked('BBB', 0.7, { side: 'call', shortStrike: 110 }) },
  ];
  return run('2026-10-23', symbols, candidates);
};
const weights = (over: Partial<RankWeights> = {}): RankWeights => ({ ivPercentile: 0, ivOverHv: 0, returnOnRisk: 0, pop: 0, legSpread: 0, distance: 0, ...over });

test('re-scoring uses the weights given and leaves the saved scores on the input alone', () => {
  const s = scan();
  const popOnly = M.rescore(s.candidates, weights({ pop: 1 })) as RankedCandidate[];
  close(popOnly[0]!.score, 0.2);
  close(popOnly[1]!.score, 0.9);
  assert.equal(s.candidates[0]!.score, 0.9, 'the input is untouched');
});

test('sorting: best first by default, the other way on request, missing values last, ties settled by symbol', () => {
  const s = scan();
  const byScore = M.sortCandidates(s.candidates, 'score', 'desc') as RankedCandidate[];
  assert.deepEqual(plain(byScore.map((c) => c.score)), [0.9, 0.7, 0.6, 0.5]);
  assert.deepEqual(plain((M.sortCandidates(s.candidates, 'score', 'asc') as RankedCandidate[]).map((c) => c.score)), [0.5, 0.6, 0.7, 0.9]);
  assert.deepEqual(plain((M.sortCandidates(s.candidates, 'symbol', 'asc') as RankedCandidate[]).map((c) => c.symbol)), ['AAA', 'AAA', 'AAA', 'BBB']);
  const gappy = s.candidates.map((c, i) => (i === 0 ? { ...c, components: { ...c.components, ivOverHv: null } } : c));
  const sorted = M.sortCandidates(gappy, 'ivOverHv', 'desc') as RankedCandidate[];
  assert.equal(sorted.at(-1)!.components.ivOverHv, null);
  assert.equal((M.sortCandidates(gappy, 'ivOverHv', 'asc') as RankedCandidate[]).at(-1)!.components.ivOverHv, null, 'also last when ascending');
  // IV rank: runs saved before it was kept have none, and sort last rather than breaking the sort
  const ranked = s.candidates.map((c, i) => (i === 0 ? c : { ...c, components: { ...c.components, ivRank: 0.1 * i } }));
  const byRank = M.sortCandidates(ranked, 'ivRank', 'desc') as RankedCandidate[];
  assert.deepEqual(plain(byRank.slice(0, 3).map((c) => c.components.ivRank)), [0.30000000000000004, 0.2, 0.1]);
  assert.equal(byRank.at(-1)!.components.ivRank, undefined);
  assert.equal(M.defaultDirection('score'), 'desc');
  assert.equal(M.defaultDirection('slippage'), 'asc');
});

test('filters: side, width, expiration, kind, search, and the numeric limits; a missing figure fails a limit that asks for it', () => {
  const s = scan();
  const f = () => M.emptyFilters();
  const count = (over: object) => (M.filterCandidates(s.candidates, s.symbols, { ...f(), ...over }) as unknown[]).length;
  assert.equal(count({}), 4);
  assert.equal(count({ put: false }), 1);
  assert.equal(count({ call: false }), 3);
  assert.equal(count({ widths: [5] }), 4);
  assert.equal(count({ widths: [6] }), 0);
  assert.equal(count({ expiration: '2026-10-23' }), 4);
  assert.equal(count({ expiration: '2026-12-04' }), 0);
  assert.equal(count({ expiration: '2027-01-01' }), 0);
  assert.equal(count({ kind: 'funds' }), 1);
  assert.equal(count({ kind: 'stocks' }), 3);
  assert.equal(count({ search: ' aa' }), 3);
  assert.equal(count({ minReturn: 1000 }), 0);
  assert.equal(count({ minPop: 0 }), 4);
  assert.equal(count({ maxSlippage: 0 }), 0);
  assert.equal(count({ minIvPercentile: 50 }), 4, 'components carry 0.5 in the fixtures');
  const missing = s.candidates.map((c) => ({ ...c, components: { ...c.components, ivOverHv: null } }));
  assert.equal((M.filterCandidates(missing, s.symbols, { ...f(), minIvOverHv: 1 }) as unknown[]).length, 0);
  assert.equal((M.filterCandidates(missing, s.symbols, f()) as unknown[]).length, 4);
});

test('the per-symbol cap keeps the first few of each symbol, in the order given, and 0 keeps all', () => {
  const s = scan();
  const sorted = M.sortCandidates(s.candidates, 'score', 'desc') as RankedCandidate[];
  assert.deepEqual(plain((M.capPerUnderlying(sorted, 1) as RankedCandidate[]).map((c) => c.score)), [0.9, 0.7]);
  assert.deepEqual(plain((M.capPerUnderlying(sorted, 2) as RankedCandidate[]).map((c) => c.score)), [0.9, 0.7, 0.6]);
  assert.equal((M.capPerUnderlying(sorted, 0) as unknown[]).length, 4);
});

test('the per-symbol cap counts each side on its own, so the calls cannot crowd out the puts', () => {
  const s = scan();
  const mixed = [...s.candidates, ranked('AAA', 0.4, { side: 'call', shortStrike: 112 })];
  const sorted = M.sortCandidates(mixed, 'score', 'desc') as RankedCandidate[];
  const kept = M.capPerUnderlying(sorted, 1) as RankedCandidate[];
  assert.deepEqual(plain(kept.map((c) => `${c.symbol} ${c.spread.side} ${c.score}`)), ['AAA put 0.9', 'BBB call 0.7', 'AAA call 0.4']);
});

test('the list on screen: the cap is applied after sorting, so it keeps the best by the chosen sort', () => {
  const s = scan();
  const withPop = M.visible(s, weights({ pop: 1 }), { ...M.emptyFilters(), perUnderlying: 1 }, 'score', 'desc') as RankedCandidate[];
  const aaa = withPop.find((c) => c.symbol === 'AAA')!;
  assert.equal(aaa.spread.short.strike, 88, 'the AAA spread with the best chance of profit, since only pop is weighted');
});

test('ruler: the stock at the middle, puts to the left and calls to the right, off-scale strikes flagged', () => {
  const s = scan();
  const put = M.ruler(s.candidates[0], s.symbols['AAA']);
  assert.ok(put.short < 0.5 && put.long < put.short, 'a put spread sits below the stock, its long leg further out');
  close(put.band[0] + put.band[1], 1, 1e-9);
  assert.equal(put.clipped, false);
  const call = M.ruler(s.candidates[3], s.symbols['BBB']);
  assert.ok(call.short > 0.5 && call.long > call.short);
  const far = M.ruler(ranked('AAA', 0.5, { shortStrike: 40 }), s.symbols['AAA']);
  assert.equal(far.clipped, true);
  assert.ok(far.short >= 0 && far.short <= 1, 'clamped onto the ruler');
  assert.notEqual(M.ruler(s.candidates[0], { ...s.symbols['AAA']!, ivIndex: null }), null, 'the option has its own IV, so a missing index does not matter');
  const noIv = (c: RankedCandidate): RankedCandidate => ({ ...c, spread: { ...c.spread, short: { ...c.spread.short, iv: 0 } } });
  assert.equal(M.ruler(noIv(s.candidates[0]!), { ...s.symbols['AAA']!, ivIndex: null }), null, 'with neither, there is nothing to measure in');
  // the ruler is in expected moves, so the band is always the same width; the short option's IV decides how far out its strike falls
  const calm = (c: RankedCandidate): RankedCandidate => ({ ...c, spread: { ...c.spread, short: { ...c.spread.short, iv: 0.15 } } });
  const wide = M.ruler(s.candidates[0], s.symbols['AAA'])!;
  const narrow = M.ruler(calm(s.candidates[0]!), s.symbols['AAA'])!;
  close(narrow.band[1] - narrow.band[0], wide.band[1] - wide.band[0], 1e-12);
  assert.ok(narrow.distance > wide.distance && Math.abs(narrow.short - 0.5) > Math.abs(wide.short - 0.5), 'a calmer option puts the same strike further out in its own moves');
  // distance is in expected moves: 10 points below at 30% IV over 52 days is about 0.78 of a move
  close(put.distance, 10 / (100 * 0.3 * Math.sqrt(52 / 365)), 1e-9);
});

test('dates, widths and expirations as the page lists them', () => {
  const s = scan();
  assert.equal(M.shortDate('2026-11-30'), 'Nov 30');
  assert.equal(M.shortDate('2027-01-02'), 'Jan 2');
  assert.deepEqual(plain(M.distinctWidths(s.candidates)), [5]);
  assert.deepEqual(plain(M.distinctExpirations(s.candidates)), [{ date: '2026-10-23', dte: 52 }]);
});

test('the report embeds the scan so it opens from disk, and the data cannot break out of its tag', () => {
  const s = scan();
  s.dropped = [{ reason: 'a </script><script>alert(1)</script> reason', symbols: ['X Y'] }];
  const template = readFileSync(webPath('index.html'), 'utf8');
  const page = renderReport(template, s);
  assert.ok(!page.includes(DATA_MARKER), 'the placeholder is replaced');
  const body = /<script id="scan-data" type="application\/json">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(body, 'one data script');
  assert.ok(!body[1]!.includes('<'), 'no raw < inside the data');
  assert.ok(!body[1]!.includes(' '), 'no raw line separator inside the data');
  assert.deepEqual(JSON.parse(body[1]!), JSON.parse(JSON.stringify(s)), 'and it parses back to the same scan');
  assert.equal((page.match(/<script id="scan-data"/g) ?? []).length, 1);
  assert.throws(() => renderReport('<html></html>', s), /placeholder/);
  assert.equal(jsonForScript({ a: '<' }), '{"a":"\\u003c"}');
});

test('the page template carries its placeholder and loads files that exist', () => {
  const template = readFileSync(webPath('index.html'), 'utf8');
  assert.ok(template.includes(DATA_MARKER));
  for (const asset of REPORT_ASSETS) {
    assert.ok(template.includes(`src="${asset}"`), `${asset} is loaded by the page`);
    assert.ok(readFileSync(webPath(asset), 'utf8').length > 100, `${asset} exists`);
  }
  const first = /PRESETS = \[\s*\{ name: "[^"]+", colors: \[([^\]]*)\]/.exec(readFileSync(webPath('palette.js'), 'utf8'))?.[1]?.replace(/[" ]/g, '');
  assert.match(first ?? '', /^#[0-9a-f]{6},#[0-9a-f]{6},#[0-9a-f]{6}$/);
  assert.ok(template.includes(`data-palette="${first}"`), 'the page default is the first preset, so the picker never opens on a palette it does not list');
});

test('net greeks: the leg bought minus the leg sold, so a bull put spread leans up and a bear call spread leans down', () => {
  const g = (delta: number, gamma: number, theta: number, vega: number, rho: number) => ({ delta, gamma, theta, vega, rho });
  const put = ranked('AAA', 0.5, {});
  const withGreeks = (c: RankedCandidate, sold: ReturnType<typeof g>, bought: ReturnType<typeof g>): RankedCandidate => ({ ...c, spread: { ...c.spread, short: { ...c.spread.short, ...sold }, long: { ...c.spread.long, ...bought } } });
  // a put spread: puts have negative delta; the sold put is nearer the money, so it has more of everything
  const bull = M.netGreeks(withGreeks(put, g(-0.2, 0.02, -0.08, 0.5, -0.1), g(-0.15, 0.015, -0.06, 0.4, -0.08)).spread);
  close(bull.delta, 0.05, 1e-12);
  close(bull.gamma, -0.005, 1e-12);
  close(bull.theta, 0.02, 1e-12);
  close(bull.vega, -0.1, 1e-12);
  close(bull.rho, 0.02, 1e-12);
  const bear = M.netGreeks(withGreeks(put, g(0.21, 0.008, -0.12, 0.75, 0.18), g(0.17, 0.007, -0.1, 0.65, 0.15)).spread);
  close(bear.delta, -0.04, 1e-12);
  assert.ok(bear.theta > 0, 'the seller collects time decay');
  // a run saved before the greeks were kept has none, so there is no net to show
  assert.equal(M.netGreeks(put.spread), null);
  assert.equal(M.netGreeks(withGreeks(put, g(-0.2, 0.02, -0.08, 0.5, -0.1), { ...g(-0.15, 0.015, -0.06, 0.4, -0.08), vega: null as unknown as number }).spread), null);
});

test('OptionStrat links: the leg bought, then the leg sold with a minus, in the form the site itself produces', () => {
  const base = ranked('AAA', 0.5, {});
  const make = (symbol: string, side: 'put' | 'call', expiration: string, shortStrike: number, longStrike: number): RankedCandidate => ({
    ...base,
    symbol,
    spread: { ...base.spread, side, expiration, short: { ...base.spread.short, side, strike: shortStrike }, long: { ...base.spread.long, side, strike: longStrike } },
  });
  // the user's own example, copied from OptionStrat
  assert.equal(M.optionStratUrl(make('IWM', 'put', '2026-12-04', 260, 255)), 'https://optionstrat.com/build/bull-put-spread/IWM/.IWM261204P255,-.IWM261204P260');
  // a call spread is a bear call spread, the higher strike bought; both forms were opened on the site and read back correctly
  assert.equal(M.optionStratUrl(make('SPY', 'call', '2026-12-04', 790, 795)), 'https://optionstrat.com/build/bear-call-spread/SPY/.SPY261204C795,-.SPY261204C790');
  // a half-dollar strike keeps its decimal
  assert.equal(M.optionStratUrl(make('TLT', 'put', '2026-12-04', 77.5, 72.5)), 'https://optionstrat.com/build/bull-put-spread/TLT/.TLT261204P72.5,-.TLT261204P77.5');
  // a symbol that is not plain letters (BRK/B) gets no link rather than a wrong one
  assert.equal(M.optionStratUrl(make('BRK/B', 'put', '2026-12-04', 450, 445)), null);
  // single-digit months and days keep their zeros
  assert.match(M.optionStratUrl(make('QQQ', 'call', '2027-01-08', 700, 705)) as string, /\.QQQ270108C705,-\.QQQ270108C700$/);
});

test('TradingView links: the chart page and the panel\'s widget, with a class share\'s slash as a dot', () => {
  assert.equal(M.tradingViewUrl('SPY'), 'https://www.tradingview.com/chart/?symbol=SPY');
  assert.equal(M.tradingViewUrl('BRK/B'), 'https://www.tradingview.com/chart/?symbol=BRK.B');
  assert.equal(M.tradingViewUrl('<x>'), null);
  const embed = M.tradingViewEmbedUrl('BRK/B', 'light') as string;
  assert.ok(embed.startsWith('https://s.tradingview.com/embed-widget/advanced-chart/#'));
  const settings = JSON.parse(decodeURIComponent(embed.split('#')[1] as string));
  assert.equal(settings.symbol, 'BRK.B');
  // both keys, because the endpoint has honoured each at different times
  assert.equal(settings.theme, 'light');
  assert.equal(settings.colorTheme, 'light');
});

test('"Try in spread-book" links: the trade in the fragment, in this page\'s units, and no link without a URL', () => {
  const base = ranked('AAA', 0.5, {});
  const c: RankedCandidate = {
    ...base,
    symbol: 'IWM',
    spread: {
      ...base.spread,
      side: 'put',
      expiration: '2026-12-04',
      creditMid: 0.83,
      popPct: 78.4,
      short: { ...base.spread.short, side: 'put', strike: 260, delta: -0.2, gamma: 0.02, theta: -0.05, vega: 0.21, iv: 0.24 },
      long: { ...base.spread.long, side: 'put', strike: 255, delta: -0.15, gamma: 0.016, theta: -0.04, vega: 0.17, iv: 0 },
    },
  };
  assert.equal(M.spreadBookUrl(undefined, c), null);
  assert.equal(M.spreadBookUrl('', c), null);
  const url = M.spreadBookUrl('https://book.example.com/index.html?snapshot=x#old', c) as string;
  const [head, b64] = url.split('#try=');
  assert.equal(head, 'https://book.example.com/index.html?snapshot=x', 'the base\'s own fragment is replaced');
  assert.match(b64 as string, /^[A-Za-z0-9_-]+$/, 'base64url, nothing to escape in a URL');
  const payload = JSON.parse(Buffer.from(b64 as string, 'base64url').toString());
  assert.deepEqual(payload, {
    v: 1,
    trades: [{
      symbol: 'IWM', side: 'put', expiration: '2026-12-04', qty: 1, credit: 0.83, popPct: 78.4,
      short: { strike: 260, delta: -0.2, gamma: 0.02, theta: -0.05, vega: 0.21, iv: 0.24 },
      long: { strike: 255, delta: -0.15, gamma: 0.016, theta: -0.04, vega: 0.17, iv: null },
    }],
  });
});

test('the "Paper trade" ticket names the spread and what the page showed, one contract, in the shape the ticket Lambda takes', () => {
  const c = ranked('IWM', 0.5, { shortStrike: 260 });
  const t = plain(M.paperTicket(c, 'tk-1234-abcd'));
  assert.deepEqual(t, {
    id: 'tk-1234-abcd',
    type: 'paper.open',
    trade: { symbol: 'IWM', side: 'put', expiration: c.spread.expiration, shortStrike: 260, longStrike: 255, qty: 1 },
    seen: { creditMid: c.spread.creditMid, creditNatural: c.spread.creditNatural, popPct: c.spread.popPct },
  });
});

// spread-book's reader (book.js there), when the two repositories are checked out side by side.
const bookPath = fileURLToPath(new URL('../../spread-book/book.js', import.meta.url));
test('spread-book reads the "Try in spread-book" link as the same spread', { skip: !existsSync(bookPath) && 'spread-book is not checked out next to this repository' }, () => {
  const context = vm.createContext({ atob, URLSearchParams });
  vm.runInContext(readFileSync(bookPath, 'utf8'), context);
  const SB = (context as { SpreadBook: any }).SpreadBook;
  const c = ranked('AAA', 0.5, {});
  const url = M.spreadBookUrl('https://book.example.com/', c) as string;
  const [t] = plain(SB.readTry(new URL(url).hash));
  const s = c.spread;
  const [lo, hi] = [s.short.strike, s.long.strike].sort((a, b) => a - b);
  assert.ok(t, 'spread-book accepts it');
  assert.equal(t.underlying, c.symbol);
  assert.equal(t.expiration, s.expiration);
  assert.equal(t.type, s.side === 'put' ? 'Bull Put' : 'Bear Call');
  assert.match(t.name, new RegExp(` ${lo}/${hi} (Bull Put|Bear Call) Spread$`));
  close(t.credit, s.creditMid * 100, 1e-9);
  close(t.maxLoss, s.maxRisk, 0.006);
  close(t.chance, s.popPct / 100, 1e-12);
  close(t.delta, (s.long.delta - s.short.delta) * 100, 1e-9);
});

test('the filters the page opens with: nothing hidden unless the scan\'s config says where to start', () => {
  const none = plain(M.defaultFilters(undefined));
  assert.deepEqual(none, plain(M.emptyFilters()));
  assert.deepEqual(plain(M.defaultFilters({ display: {} })), none);
  const f = M.defaultFilters({ display: { filters: { minIvPercentile: 30, maxLegSpread: 20, bogus: 5, minPop: 'x' } } });
  assert.equal(f.minIvPercentile, 30);
  assert.equal(f.maxLegSpread, 20);
  assert.equal(f.minPop, null, 'a value that is not a number is ignored');
  assert.equal(f.bogus, undefined, 'so is a name the page has no filter for');
  assert.equal(f.perUnderlying, 3);
  // and they do hide rows the way a typed limit does
  const s = scan();
  const strict = M.defaultFilters({ display: { filters: { minIvPercentile: 99 } } });
  assert.equal((M.visible(s, s.weights, strict, 'score', 'desc') as RankedCandidate[]).length, 0);
  assert.ok((M.visible(s, s.weights, M.defaultFilters(undefined), 'score', 'desc') as RankedCandidate[]).length > 0);
});

test('the simulated-outcome columns sort, with a spread that has none last whichever way it goes', () => {
  const s = scan();
  const outcome = (winRate: number, breakEvenWinRate: number, ev: number) => ({ winRate, pTarget: 50, pStop: 20, pTime: 30, avgWin: 30, avgLoss: 120, ev, breakEvenWinRate, edge: winRate - breakEvenWinRate });
  const withOutcomes = s.candidates.map((c, i) => (i === 0 ? c : { ...c, outcome: outcome(60 + i * 5, 80 - i * 2, -20 + i * 6) }));
  const best = (key: string, dir: string) => (M.sortCandidates(withOutcomes, key, dir) as RankedCandidate[]).map((c) => c.outcome?.winRate);
  assert.deepEqual(plain(best('managedWin', 'desc')).slice(0, 3), [75, 70, 65]);
  const needs = (M.sortCandidates(withOutcomes, 'needs', 'asc') as RankedCandidate[]).map((c) => c.outcome?.breakEvenWinRate);
  assert.deepEqual(plain(needs).slice(0, 3), [74, 76, 78], 'a lower break-even is better, so it sorts ascending by default');
  assert.equal(M.defaultDirection('needs'), 'asc');
  assert.equal(M.defaultDirection('ev'), 'desc');
  for (const key of ['managedWin', 'needs', 'ev']) {
    for (const dir of ['asc', 'desc']) assert.equal((M.sortCandidates(withOutcomes, key, dir) as RankedCandidate[]).at(-1)!.outcome, undefined, `${key} ${dir}: the one without an outcome is last`);
  }
});
