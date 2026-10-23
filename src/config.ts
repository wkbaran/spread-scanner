import { readFileSync, existsSync } from 'node:fs';
import type { ScannerConfig } from './types.ts';

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
