import type { ScannerConfig } from './types.ts';

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to`, both YYYY-MM-DD. Dates only, so no time zone enters. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Report dates from any mix of sources, split around `today`. A date before today is a report
 * that has happened (tastytrade's `expected-report-date` is the last report once a company has
 * reported); today or later is one still to come. The next report is the EARLIEST future date,
 * because two sources disagree by more than a day on about one symbol in twenty and the
 * cautious reading is the nearer one.
 */
export function splitReportDates(dates: string[], today: string): { last: string | null; next: string | null } {
  const past = dates.filter((d) => d < today).sort();
  const future = dates.filter((d) => d >= today).sort();
  return { last: past.at(-1) ?? null, next: future[0] ?? null };
}

export interface EarningsVerdict {
  ok: boolean;
  reason: string;
  last: string | null;
  next: string | null;
  daysSinceLast: number | null;
  daysUntilNext: number | null;
}

/**
 * Eligible when the last report was at least `minDaysSinceLast` days ago and the next is at least
 * `minDaysUntilNext` days away. An unknown date fails: a name with no date on file might report
 * tomorrow, and a miss here costs more than a skipped name.
 */
export function earningsVerdict(dates: string[], today: string, cfg: ScannerConfig): EarningsVerdict {
  const { last, next } = splitReportDates(dates, today);
  const daysSinceLast = last === null ? null : daysBetween(last, today);
  const daysUntilNext = next === null ? null : daysBetween(today, next);
  const verdict = (ok: boolean, reason: string): EarningsVerdict => ({ ok, reason, last, next, daysSinceLast, daysUntilNext });
  if (daysUntilNext === null) return verdict(false, 'no upcoming report date known');
  if (daysSinceLast === null) return verdict(false, 'no past report date known');
  if (daysSinceLast < cfg.earnings.minDaysSinceLast) return verdict(false, `reported ${daysSinceLast} days ago`);
  if (daysUntilNext < cfg.earnings.minDaysUntilNext) return verdict(false, `reports in ${daysUntilNext} days`);
  return verdict(true, 'clear');
}
