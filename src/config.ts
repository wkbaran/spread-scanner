import { readFileSync, existsSync } from 'node:fs';
import { DISPLAY_FILTERS, type ScannerConfig } from './types.ts';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; anything else, arrays included, is replaced by the override. */
export function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

export function validateConfig(c: ScannerConfig): ScannerConfig {
  const fail = (why: string): never => {
    throw new Error(`Invalid config: ${why}`);
  };
  if (!(c.dte.min > 0 && c.dte.min <= c.dte.max)) fail('dte.min must be positive and no larger than dte.max');
  if (!(c.delta.min > 0 && c.delta.min <= c.delta.max && c.delta.max < 0.5)) {
    fail('delta needs 0 < min <= max < 0.5, as absolute values');
  }
  if (!(c.width.min > 0 && c.width.min <= c.width.max)) fail('width.min must be positive and no larger than width.max');
  if (!(c.maxLegSpreadPct > 0)) fail('maxLegSpreadPct must be positive');
  if (!(c.delta.min - c.strikeSelection.deltaSlack > 0)) fail('strikeSelection.deltaSlack must be smaller than delta.min');
  if (!(c.universe.minLiquidityRating >= 0 && c.universe.minLiquidityRating <= 5)) fail('universe.minLiquidityRating must be between 0 and 5');
  if (!(c.strikeSelection.rate >= 0 && c.strikeSelection.rate <= 0.2)) fail('strikeSelection.rate is an annual rate as a fraction, e.g. 0.04');
  const o = c.outcome;
  if (!(o.takeProfit > 0 && o.takeProfit <= 1)) fail('outcome.takeProfit is a fraction of the credit, above 0 and at most 1');
  if (!(o.stopLoss > 0 && o.stopLoss <= 1)) fail('outcome.stopLoss is a fraction of the most that can be lost, above 0 and at most 1');
  if (!(Number.isInteger(o.exitDte) && o.exitDte >= 0)) fail('outcome.exitDte is a whole number of days, 0 or more');
  if (!(o.fillShare >= 0 && o.fillShare <= 1)) fail('outcome.fillShare is between 0 (trade at the mid) and 1 (the worst price)');
  if (!(o.volEdge >= 0 && o.volEdge <= 1)) fail('outcome.volEdge is between 0 and 1');
  if (!(o.ivDecay >= 0 && o.ivDecay < 1)) fail('outcome.ivDecay is at least 0 and under 1');
  if (!(Number.isInteger(o.paths) && o.paths >= 100 && Number.isInteger(o.intraday) && o.intraday >= 1)) fail('outcome.paths is at least 100 and outcome.intraday at least 1, both whole numbers');
  if (!(Number.isInteger(c.universe.maxNames) && c.universe.maxNames >= 1)) fail('universe.maxNames must be a whole number of at least 1');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: c.display.timeZone });
  } catch {
    fail(`display.timeZone is not a time zone name: ${String(c.display.timeZone)} (use e.g. America/New_York)`);
  }
  for (const [key, value] of Object.entries(c.display.filters ?? {})) {
    if (!(DISPLAY_FILTERS as readonly string[]).includes(key)) fail(`display.filters.${key} is not a filter the report has (${DISPLAY_FILTERS.join(', ')})`);
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) fail(`display.filters.${key} must be a number, 0 or more`);
  }
  const w = Object.values(c.ranking.weights);
  if (w.some((x) => !(x >= 0)) || !(w.reduce((a, b) => a + b, 0) > 0)) fail('ranking.weights must be non-negative and not all zero');
  return c;
}

/** config/default.json, overridden key by key by the local file when it exists. */
export function loadConfig(defaultPath: string, localPath?: string): ScannerConfig {
  let merged = JSON.parse(readFileSync(defaultPath, 'utf8')) as Json;
  if (localPath !== undefined && existsSync(localPath)) {
    merged = deepMerge(merged, JSON.parse(readFileSync(localPath, 'utf8')) as Json);
  }
  return validateConfig(merged as unknown as ScannerConfig);
}
