import type { Cache } from './cache.ts';
import type { Sofr } from './providers/nyfed.ts';
import type { ScannerConfig } from './types.ts';

const RATE_TTL_MS = 12 * 3_600_000;
/** A published overnight rate outside this is a parsing accident, not a rate (the real range this century is 0 to about 5.5%). */
const PLAUSIBLE = { min: -0.01, max: 0.2 };

export interface ResolvedRate {
  value: number;
  /** Where the number came from, for the saved run: "SOFR 2026-10-22" or "config". */
  source: string;
}

/**
 * The risk-free rate the scan uses to place its strike band: the latest SOFR when the config asks for it,
 * cached for the day, else (or when the fetch fails or looks wrong) the configured rate. It never stops a scan.
 */
export async function resolveRate(
  cfg: ScannerConfig,
  fetchSofr: () => Promise<Sofr>,
  cache: Cache,
  log: (message: string) => void = () => undefined,
): Promise<ResolvedRate> {
  const fixed: ResolvedRate = { value: cfg.strikeSelection.rate, source: 'config' };
  if (!cfg.strikeSelection.rateFromSofr) return fixed;
  try {
    const sofr = await cache.getOrFetch('sofr', RATE_TTL_MS, fetchSofr);
    if (!(sofr.rate >= PLAUSIBLE.min && sofr.rate <= PLAUSIBLE.max)) throw new Error(`implausible rate ${sofr.rate}`);
    return { value: sofr.rate, source: `SOFR ${sofr.date}` };
  } catch (error) {
    log(`SOFR unavailable (${error instanceof Error ? error.message : 'error'}); using the configured ${(fixed.value * 100).toFixed(2)}%`);
    return fixed;
  }
}
