import { addDays, daysBetween } from './dates.ts';
import type { ScannerConfig } from './types.ts';

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

/** The dates a calendar fetch spans, inclusive: what a complete earnings calendar was asked for. */
export interface CalendarCoverage {
  from: string;
  to: string;
}

/** The window an earnings calendar must span for a missing date to be good news rather than a gap. */
export function requiredCoverage(today: string, cfg: ScannerConfig): CalendarCoverage {
  return {
    from: addDays(today, -(cfg.earnings.minDaysSinceLast - 1)),
    to: addDays(today, cfg.earnings.minDaysUntilNext - 1),
  };
}

/**
 * Eligible when the last report was at least `minDaysSinceLast` days ago and the next is at least
 * `minDaysUntilNext` days away.
 *
 * A date that is not known passes only when `coverage` shows a complete calendar was fetched for
 * the whole window where a report would matter: then no entry means no report there, which is the
 * case for a company that has just reported and has no next date on file yet. Without that
 * coverage an unknown date fails, because a name with no date on file might report tomorrow and a
 * miss here costs more than a skipped name.
 */
export function earningsVerdict(dates: string[], today: string, cfg: ScannerConfig, coverage?: CalendarCoverage): EarningsVerdict {
  const { last, next } = splitReportDates(dates, today);
  const daysSinceLast = last === null ? null : daysBetween(last, today);
  const daysUntilNext = next === null ? null : daysBetween(today, next);
  const verdict = (ok: boolean, reason: string): EarningsVerdict => ({ ok, reason, last, next, daysSinceLast, daysUntilNext });

  if (daysSinceLast !== null && daysSinceLast < cfg.earnings.minDaysSinceLast) return verdict(false, `reported ${daysSinceLast} days ago`);
  if (daysUntilNext !== null && daysUntilNext < cfg.earnings.minDaysUntilNext) return verdict(false, `reports in ${daysUntilNext} days`);

  const needed = requiredCoverage(today, cfg);
  const covered = coverage !== undefined && coverage.from <= needed.from && coverage.to >= needed.to;
  if (daysUntilNext === null && !covered) return verdict(false, 'no upcoming report date known');
  if (daysSinceLast === null && !covered) return verdict(false, 'no past report date known');
  return verdict(true, daysUntilNext === null ? 'no report inside the window' : 'clear');
}
