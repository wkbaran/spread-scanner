import { addDays, daysBetween } from '../dates.ts';
import { Http } from '../http.ts';

export interface EarningsRow {
  symbol: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface DailyBar {
  date: string;
  close: number;
}

/** What the earnings calendar returns at most. Past it, FMP silently keeps only the latest dates. */
export const CALENDAR_ROW_CAP = 4000;

type Json = Record<string, unknown>;

/** Financial Modeling Prep, the stable API. The key travels in the query string, so errors never print URLs. */
export class Fmp {
  private readonly apiKey: string;
  private readonly http: Http;
  private readonly baseUrl: string;

  constructor(apiKey: string, http: Http, baseUrl = 'https://financialmodelingprep.com/stable') {
    this.apiKey = apiKey;
    this.http = http;
    this.baseUrl = baseUrl;
  }

  private async get(path: string): Promise<Json[]> {
    const url = `${this.baseUrl}${path}${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(this.apiKey)}`;
    const body = await this.http.json<unknown>(url);
    return Array.isArray(body) ? (body as Json[]) : [];
  }

  /**
   * Reports between two dates, inclusive. A range holding CALENDAR_ROW_CAP rows or more has been
   * truncated, so it is split in half and fetched again; one day that still hits the cap is an error.
   */
  async earningsCalendar(from: string, to: string): Promise<EarningsRow[]> {
    const rows = await this.get(`/earnings-calendar?from=${from}&to=${to}`);
    if (rows.length >= CALENDAR_ROW_CAP) {
      if (from >= to) throw new Error(`The earnings calendar for ${from} alone reaches its ${CALENDAR_ROW_CAP}-row cap`);
      const middle = addDays(from, Math.floor(daysBetween(from, to) / 2));
      return [...(await this.earningsCalendar(from, middle)), ...(await this.earningsCalendar(addDays(middle, 1), to))];
    }
    const out: EarningsRow[] = [];
    for (const row of rows) {
      if (typeof row['symbol'] === 'string' && typeof row['date'] === 'string') out.push({ symbol: row['symbol'], date: row['date'] });
    }
    return out;
  }

  /** Daily closes, oldest first. */
  async dailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
    const rows = await this.get(`/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
    const out: DailyBar[] = [];
    for (const row of rows) {
      const close = Number(row['close']);
      if (typeof row['date'] === 'string' && Number.isFinite(close)) out.push({ date: row['date'], close });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
}
