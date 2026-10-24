import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const context = vm.createContext({});
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
  assert.equal(M.ruler(s.candidates[0], { ...s.symbols['AAA']!, ivIndex: null }), null);
  // distance is in expected moves: 10 points below at 30% IV over 52 days is about 0.78 of a move
  close(put.distance, 10 / (100 * 0.3 * Math.sqrt(52 / 365)), 1e-9);
});

test('how a spread is said to a broker', () => {
  const s = scan();
  assert.equal(M.describe(s.candidates[0]), 'AAA Oct 23 90/85 put spread, credit 0.63');
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
