const DAY_MS = 86_400_000;

/** Whole days from `from` to `to`, both YYYY-MM-DD. Dates only, so no time zone enters. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The New York calendar date of an instant. Market logic uses this and never the UTC date: UTC
 * midnight falls during the evening session, and the machine's own zone is for people.
 */
export function easternDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Consecutive windows of at most `days` days covering from..to, inclusive at both ends. */
export function dateWindows(from: string, to: string, days: number): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    out.push({ from: start, to: end < to ? end : to });
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
