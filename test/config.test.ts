import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deepMerge, loadConfig, validateConfig } from '../src/config.ts';
import { config } from './fixtures.ts';

const defaultPath = fileURLToPath(new URL('../config/default.json', import.meta.url));

test('objects merge key by key and arrays are replaced', () => {
  const merged = deepMerge({ dte: { min: 35, max: 45 }, widths: [5] }, { dte: { min: 37 }, widths: [5, 6] });
  assert.deepEqual(merged, { dte: { min: 37, max: 45 }, widths: [5, 6] });
});

test('the committed defaults load and pass validation', () => {
  const cfg = loadConfig(defaultPath);
  assert.ok(cfg.delta.min < cfg.delta.max);
  assert.ok(cfg.widths.length > 0);
});

test('a local file that does not exist is not an error', () => {
  assert.deepEqual(loadConfig(defaultPath, '/nonexistent/local.json'), loadConfig(defaultPath));
});

test('nonsense is rejected', () => {
  assert.throws(() => validateConfig(config({ delta: { min: 0.3, max: 0.2 } })), /delta/);
  assert.throws(() => validateConfig(config({ delta: { min: 0.15, max: 0.5 } })), /delta/);
  assert.throws(() => validateConfig(config({ dte: { min: 45, max: 37 } })), /dte/);
  assert.throws(() => validateConfig(config({ widths: [] })), /widths/);
  assert.throws(() => validateConfig(config({ maxLegSpreadPct: 0 })), /maxLegSpreadPct/);
});
