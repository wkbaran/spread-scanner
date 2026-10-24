import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deepMerge, loadConfig, validateConfig } from '../src/config.ts';
import { config } from './fixtures.ts';

const defaultPath = fileURLToPath(new URL('../config/default.json', import.meta.url));

test('objects merge key by key and arrays are replaced', () => {
  const merged = deepMerge({ dte: { min: 35, max: 45 }, tags: ['a'] }, { dte: { min: 37 }, tags: ['b', 'c'] });
  assert.deepEqual(merged, { dte: { min: 37, max: 45 }, tags: ['b', 'c'] });
});

test('the committed defaults load and pass validation', () => {
  const cfg = loadConfig(defaultPath);
  assert.ok(cfg.delta.min < cfg.delta.max);
  assert.ok(cfg.width.min <= cfg.width.max);
});

test('a local file that does not exist is not an error', () => {
  assert.deepEqual(loadConfig(defaultPath, '/nonexistent/local.json'), loadConfig(defaultPath));
});

test('nonsense is rejected', () => {
  assert.throws(() => validateConfig(config({ delta: { min: 0.3, max: 0.2 } })), /delta/);
  assert.throws(() => validateConfig(config({ delta: { min: 0.15, max: 0.5 } })), /delta/);
  assert.throws(() => validateConfig(config({ dte: { min: 45, max: 37 } })), /dte/);
  assert.throws(() => validateConfig(config({ width: { min: 0, max: 10 } })), /width/);
  assert.throws(() => validateConfig(config({ width: { min: 11, max: 10 } })), /width/);
  assert.throws(() => validateConfig(config({ maxLegSpreadPct: 0 })), /maxLegSpreadPct/);
});

test('a display time zone that is not one is rejected, and the committed default is accepted', () => {
  const base = config();
  assert.doesNotThrow(() => validateConfig({ ...base, display: { timeZone: 'Europe/London' } }));
  assert.throws(() => validateConfig({ ...base, display: { timeZone: 'Mountain' } }), /display\.timeZone/);
});

test('the funnel settings are checked', () => {
  const base = config();
  assert.doesNotThrow(() => validateConfig({ ...base, universe: { minLiquidityRating: 0, maxNames: 1 } }));
  assert.throws(() => validateConfig({ ...base, universe: { minLiquidityRating: 6, maxNames: 10 } }), /minLiquidityRating/);
  assert.throws(() => validateConfig({ ...base, universe: { minLiquidityRating: 4, maxNames: 0 } }), /maxNames/);
  assert.throws(() => validateConfig({ ...base, universe: { minLiquidityRating: 4, maxNames: 2.5 } }), /maxNames/);
});

test('the rate must be an annual fraction, not a percent', () => {
  const base = config();
  assert.doesNotThrow(() => validateConfig({ ...base, strikeSelection: { ...base.strikeSelection, rate: 0.039 } }));
  assert.throws(() => validateConfig({ ...base, strikeSelection: { ...base.strikeSelection, rate: 3.9 } }), /strikeSelection\.rate/);
});
