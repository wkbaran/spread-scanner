import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHoldings, readHoldings } from '../src/held.ts';

// The fields of spread-book's brief (brief.js there, `position`) that the report reads.
const position = (over: Record<string, unknown> = {}) => ({
  name: 'QQQ Dec 4th 775/770 Bear Call Spread', underlying: 'QQQ', kind: 'call', strikes: '775/770', expiration: '2026-12-04',
  shortStrike: 770, returnPct: 12.3, exit: null, ...over,
});
const brief = (positions: unknown[]) => ({ schema: 'spread-book/brief@1', generatedAt: '2026-10-28T19:25:00.000Z', positions });

test('a held spread: the short strike as spread-book gives it, the long the other, whichever order the name has them', () => {
  const h = readHoldings(brief([position(), position({ name: 'SPY Nov 27th 615/620 Bull Put Spread', underlying: 'SPY', kind: 'put', strikes: '615/620', expiration: '2026-11-27', shortStrike: 620, exit: 'close' })]));
  assert.ok(h);
  assert.equal(h.asOf, '2026-10-28T19:25:00.000Z');
  assert.deepEqual(h.spreads.map((s) => [s.symbol, s.side, s.expiration, s.shortStrike, s.longStrike, s.exit]), [
    ['QQQ', 'call', '2026-12-04', 770, 775, null],
    ['SPY', 'put', '2026-11-27', 620, 615, 'close'],
  ]);
  assert.equal(h.spreads[0]!.key, 'QQQ Dec 4th 775/770 Bear Call Spread|2026-12-04|775/770', "spread-book's spreadKey");
  assert.equal(h.spreads[0]!.returnPct, 12.3);
});

test('only plain put and call spreads with a usable short strike are kept', () => {
  const h = readHoldings(brief([
    position({ kind: 'other' }),
    position({ strikes: '775' }),
    position({ shortStrike: null }),
    position({ shortStrike: 772 }),
    position({ strikes: 'abc/770' }),
    position({ underlying: 7 }),
    position(),
  ]));
  assert.equal(h?.spreads.length, 1);
});

test('anything that is not a spread-book brief gives no holdings rather than an error', () => {
  assert.equal(readHoldings(null), null);
  assert.equal(readHoldings([]), null);
  assert.equal(readHoldings({ schema: 'spread-book/brief@2', positions: [] }), null);
  assert.equal(readHoldings({ schema: 'spread-book/brief@1' }), null);
});

test('loading never fails the report: no path, a missing file and bad JSON all give null and say why', () => {
  const said: string[] = [];
  const log = (m: string) => void said.push(m);
  const dir = mkdtempSync(join(tmpdir(), 'held-'));
  assert.equal(loadHoldings(undefined, log), null);
  assert.equal(said.length, 0, 'no brief configured is not worth a line');
  assert.equal(loadHoldings(join(dir, 'missing.json'), log), null);
  writeFileSync(join(dir, 'bad.json'), '{');
  assert.equal(loadHoldings(join(dir, 'bad.json'), log), null);
  writeFileSync(join(dir, 'other.json'), '{}');
  assert.equal(loadHoldings(join(dir, 'other.json'), log), null);
  assert.equal(said.length, 3);
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(brief([position()])));
  assert.equal(loadHoldings(join(dir, 'latest.json'), log)?.spreads.length, 1);
});
