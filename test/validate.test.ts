import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/dates.ts';
import type { DailyBar } from '../src/providers/fmp.ts';
import type { RankedCandidate, SymbolInfo } from '../src/types.ts';
import { forwardVolatility, formatValidation, spearman, spreadOutcomes, underlyingSamples, validationReport } from '../src/validate.ts';
import { close } from './fixtures.ts';
import { info, ranked, run } from './scans.ts';

/** Daily bars from `start`, one a day, closes from `path(i)`. */
const bars = (start: string, n: number, path: (i: number) => number): DailyBar[] =>
  Array.from({ length: n }, (_, i) => ({ date: addDays(start, i), close: path(i) }));

const alternating = (step: number) => (i: number): number => 100 * (i % 2 === 0 ? (1 + step) ** (i / 2 + 1) * (1 + step) ** (-(i / 2)) : 1);

test('rank correlation: perfect, reversed, too few pairs, and no spread in one series', () => {
  close(spearman([1, 2, 3, 4, 5, 6], [10, 20, 30, 40, 50, 60]) ?? NaN, 1);
  close(spearman([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]) ?? NaN, -1);
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), null);
  assert.equal(spearman([1, 2, 3, 4, 5], [7, 7, 7, 7, 7]), null);
});

test('forward volatility is read only once the window has played out', () => {
  const series = bars('2026-09-01', 60, (i) => 100 * 1.01 ** (i % 2 === 0 ? 1 : 0));
  const hv = forwardVolatility(series, '2026-09-10', 30);
  assert.ok(hv !== null && hv > 0.1 && hv < 0.3, `got ${hv}`);
  assert.equal(forwardVolatility(series, '2026-10-15', 30), null, 'the window runs past the last bar');
  assert.equal(forwardVolatility([], '2026-09-10', 30), null);
});

test('an underlying sample compares the IV at the time with the volatility that followed', () => {
  const calm = bars('2026-09-01', 60, () => 100); // never moves
  const wild = bars('2026-09-01', 60, (i) => 100 * (i % 2 === 0 ? 1.05 : 1));
  const runs = [run('2026-09-10', { CALM: info(0.3), WILD: info(0.3), NEW: info(0.3) }, [])];
  const samples = underlyingSamples(runs, new Map([['CALM', calm], ['WILD', wild]]));
  assert.deepEqual(samples.map((s) => s.symbol), ['CALM', 'WILD'], 'NEW has no bars');
  assert.ok(samples[0]!.forwardHv === 0 && samples[1]!.forwardHv > 0.5);
  close(samples[0]!.ivOverHv ?? NaN, 0.3 / 0.2);
});

test('a spread is judged at its exit date: touching the short strike and recovering is not a loss', () => {
  // expires 2026-10-23, so the exit date is 2026-10-02; entered 2026-09-01
  const dips = bars('2026-09-01', 50, (i) => (i >= 10 && i <= 14 ? 88 : 95)); // closes below the 90 strike on days 10-14, back to 95 by exit
  const falls = bars('2026-09-01', 50, (i) => (i < 20 ? 95 : 84)); // beyond the break-even at exit
  const rises = bars('2026-09-01', 50, () => 99);
  const runs = [run('2026-09-01', { A: info(0.3), B: info(0.3), C: info(0.3) }, [ranked('A', 0.5), ranked('B', 0.5), ranked('C', 0.5)])];
  const out = spreadOutcomes(runs, new Map([['A', dips], ['B', falls], ['C', rises]]), '2026-10-20');
  const by = Object.fromEntries(out.map((o) => [o.candidate.symbol, o]));
  assert.equal(by['A']?.exitDate, '2026-10-02');
  assert.deepEqual([by['A']?.touchedShort, by['A']?.beyondBreakeven], [true, false]);
  assert.deepEqual([by['B']?.touchedShort, by['B']?.beyondBreakeven], [true, true]);
  assert.deepEqual([by['C']?.touchedShort, by['C']?.beyondBreakeven], [false, false]);
});

test('a call spread is beyond its break-even on the upside', () => {
  const up = bars('2026-09-01', 50, (i) => (i < 20 ? 105 : 125));
  const runs = [run('2026-09-01', { A: info(0.3) }, [ranked('A', 0.5, { side: 'call', shortStrike: 110 })])];
  const [o] = spreadOutcomes(runs, new Map([['A', up]]), '2026-10-20');
  assert.deepEqual([o?.touchedShort, o?.beyondBreakeven], [true, true]);
});

test('the same spread listed on several days is one trade, counted at the first listing; unmatured ones are skipped', () => {
  const flat = bars('2026-09-01', 50, () => 99);
  const runs = [
    run('2026-09-03', { A: info(0.3) }, [ranked('A', 0.5)], '2026-09-03T15:00:00Z'),
    run('2026-09-01', { A: info(0.3) }, [ranked('A', 0.7)], '2026-09-01T15:00:00Z'),
    run('2026-09-02', { A: info(0.3) }, [ranked('A', 0.5, { expiration: '2026-12-18' })]),
  ];
  const out = spreadOutcomes(runs, new Map([['A', flat]]), '2026-10-20');
  assert.equal(out.length, 1, 'the December spread has not reached its exit date');
  assert.equal(out[0]?.entry, '2026-09-01');
  assert.equal(out[0]?.candidate.score, 0.7);
});

test('the report: quintiles by score, the correlation, and the caution about small samples', () => {
  // ten spreads, strikes 80..89, entered together; higher scores are the ones that held (price stays above)
  const symbols: Record<string, SymbolInfo> = {};
  const candidates: RankedCandidate[] = [];
  const series = new Map<string, DailyBar[]>();
  for (let i = 0; i < 10; i++) {
    const s = `S${i}`;
    symbols[s] = info(0.3);
    candidates.push(ranked(s, i / 10, { shortStrike: 90 }));
    series.set(s, bars('2026-09-01', 50, () => (i < 5 ? 80 : 99))); // the five lowest scores fall through the strike
  }
  const report = validationReport([run('2026-09-01', symbols, candidates)], series, '2026-10-20');
  assert.equal(report.spreads.n, 10);
  assert.equal(report.spreads.quintiles.length, 5);
  assert.equal(report.spreads.quintiles[0]?.heldBreakeven, 0);
  assert.equal(report.spreads.quintiles[4]?.heldBreakeven, 100);
  assert.ok((report.spreads.scoreCorrelation ?? 0) > 0.8);
  assert.equal(report.underlying.n, 10);
  const text = formatValidation(report);
  assert.match(text, /Too few samples/);
  assert.match(text, /does not reprice the options/);
});

test('with nothing old enough the report is empty rather than wrong', () => {
  const report = validationReport([], new Map(), '2026-10-20');
  assert.equal(report.underlying.n, 0);
  assert.equal(report.spreads.quintiles.length, 0);
  assert.match(formatValidation(report), /0 runs/);
});
