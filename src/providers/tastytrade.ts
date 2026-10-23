import { chunk } from '../dates.ts';
import { Http, HttpError } from '../http.ts';
import type { Side } from '../types.ts';

export interface TastytradeCredentials {
  clientSecret: string;
  refreshToken: string;
  clientId?: string;
  baseUrl?: string;
}

/** Per-underlying figures. Volatilities are fractions (0.31 is 31%), whatever unit the API used. */
export interface SymbolMetrics {
  symbol: string;
  ivIndex: number | null;
  /** Where the IV index sits between its 52-week low and high, 0 to 1. */
  ivRank: number | null;
  /** Share of the past year's days with a lower IV index, 0 to 1. */
  ivPercentile: number | null;
  hv30: number | null;
  hv60: number | null;
  hv90: number | null;
  beta: number | null;
  liquidityRating: number | null;
  sector: string | null;
  /**
   * The company's report date as tastytrade holds it: the NEXT report if it has not happened,
   * the LAST once it has. Callers split it around today.
   */
  reportDate: string | null;
  reportTimeOfDay: string | null;
}

export interface InstrumentFlags {
  isEtf: boolean;
  isIndex: boolean;
  isIlliquid: boolean;
  optionsClosingOnly: boolean;
  active: boolean;
}

export interface ListedContract {
  /** The OCC-style symbol the quote call wants, spaces and all. */
  occ: string;
  strike: number;
  side: Side;
  expiration: string;
}

export interface OptionQuoteData {
  bid: number;
  ask: number;
  delta: number;
  iv: number;
  openInterest: number;
  volume: number;
}

const BATCH_METRICS = 500;
const BATCH_QUOTES = 100; // the quote call caps symbols at 100 a request
const BATCH_INSTRUMENTS = 100;
const TOKEN_LIFETIME_MS = 10 * 60_000; // tokens last 15 minutes; refresh early

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {});

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const percentToFraction = (value: unknown): number | null => {
  const n = num(value);
  return n === null ? null : n / 100;
};

/** The expiration, side and strike packed into the end of an OCC symbol: YYMMDD, C or P, strike x 1000 in 8 digits. */
export function parseOcc(occ: string): { expiration: string; side: Side; strike: number } | null {
  const m = /(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
  if (m === null) return null;
  return { expiration: `20${m[1]}-${m[2]}-${m[3]}`, side: m[4] === 'C' ? 'call' : 'put', strike: Number(m[5]) / 1000 };
}

/** tastytrade's read-only REST API: metrics, instrument flags, chain listings and quotes. */
export class Tastytrade {
  private readonly credentials: TastytradeCredentials;
  private readonly http: Http;
  private readonly baseUrl: string;
  private token: { value: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(credentials: TastytradeCredentials, http: Http, now: () => number = Date.now) {
    this.credentials = credentials;
    this.http = http;
    this.baseUrl = credentials.baseUrl ?? 'https://api.tastyworks.com';
    this.now = now;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token !== null && this.now() - this.token.at < TOKEN_LIFETIME_MS) return this.token.value;
    const body = {
      grant_type: 'refresh_token',
      refresh_token: this.credentials.refreshToken,
      client_secret: this.credentials.clientSecret,
      ...(this.credentials.clientId === undefined ? {} : { client_id: this.credentials.clientId }),
    };
    const response = await this.http.json<Json>(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = response['access_token'];
    if (typeof value !== 'string') throw new Error('tastytrade returned no access token');
    this.token = { value, at: this.now() };
    return value;
  }

  private async get(path: string): Promise<Json> {
    const call = async (force: boolean): Promise<Json> =>
      this.http.json<Json>(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${await this.accessToken(force)}` } });
    try {
      return await call(false);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return call(true); // an expired token: once more with a fresh one
      throw error;
    }
  }

  private items(response: Json): Json[] {
    const data = asObject(response['data']);
    const items = data['items'];
    return Array.isArray(items) ? items.map(asObject) : [];
  }

  async metrics(symbols: string[]): Promise<Map<string, SymbolMetrics>> {
    const out = new Map<string, SymbolMetrics>();
    for (const batch of chunk(symbols, BATCH_METRICS)) {
      const list = batch.map((s) => encodeURIComponent(s)).join(',');
      for (const item of this.items(await this.get(`/market-metrics?symbols=${list}`))) {
        const symbol = String(item['symbol'] ?? '');
        if (symbol === '') continue;
        const earnings = asObject(item['earnings']);
        const date = earnings['expected-report-date'];
        const timeOfDay = earnings['time-of-day'];
        out.set(symbol, {
          symbol,
          // the IV index and the ranks are fractions already; the 30-day IV and historical vols are percent
          ivIndex: num(item['implied-volatility-index']),
          ivRank: num(item['implied-volatility-index-rank']),
          ivPercentile: num(item['implied-volatility-percentile']),
          hv30: percentToFraction(item['historical-volatility-30-day']),
          hv60: percentToFraction(item['historical-volatility-60-day']),
          hv90: percentToFraction(item['historical-volatility-90-day']),
          beta: num(item['beta']),
          liquidityRating: num(item['liquidity-rating']),
          sector: typeof item['sector'] === 'string' ? item['sector'] : null,
          reportDate: typeof date === 'string' ? date : null,
          reportTimeOfDay: typeof timeOfDay === 'string' ? timeOfDay : null,
        });
      }
    }
    return out;
  }

  async instruments(symbols: string[]): Promise<Map<string, InstrumentFlags>> {
    const out = new Map<string, InstrumentFlags>();
    for (const batch of chunk(symbols, BATCH_INSTRUMENTS)) {
      const query = batch.map((s) => `symbol[]=${encodeURIComponent(s)}`).join('&');
      for (const item of this.items(await this.get(`/instruments/equities?${query}`))) {
        const symbol = String(item['symbol'] ?? '');
        if (symbol === '') continue;
        out.set(symbol, {
          isEtf: item['is-etf'] === true,
          isIndex: item['is-index'] === true,
          isIlliquid: item['is-illiquid'] === true,
          optionsClosingOnly: item['is-options-closing-only'] === true,
          active: item['active'] !== false,
        });
      }
    }
    return out;
  }

  /** The mark of each underlying, from the real-time quote. */
  async equityQuotes(symbols: string[]): Promise<Map<string, { mark: number }>> {
    const out = new Map<string, { mark: number }>();
    for (const batch of chunk(symbols, BATCH_QUOTES)) {
      const list = batch.map((s) => encodeURIComponent(s)).join(',');
      for (const item of this.items(await this.get(`/market-data/by-type?equity=${list}`))) {
        const mark = num(item['mark']) ?? num(item['mid']) ?? num(item['last']);
        if (mark !== null && typeof item['symbol'] === 'string') out.set(item['symbol'], { mark });
      }
    }
    return out;
  }

  /**
   * Every standard contract of an underlying, all expirations, no prices. The listing comes as one
   * item per expiration type (Weekly, Regular, ...). Adjusted contracts (a non-standard chain, with
   * deliverables other than 100 shares) are left out.
   */
  async chainListing(symbol: string): Promise<ListedContract[]> {
    const response = await this.get(`/option-chains/${encodeURIComponent(symbol)}/compact`);
    const out: ListedContract[] = [];
    for (const item of this.items(response)) {
      if (item['option-chain-type'] !== 'Standard') continue;
      const symbols = item['symbols'];
      if (!Array.isArray(symbols)) continue;
      for (const occ of symbols) {
        if (typeof occ !== 'string') continue;
        const parsed = parseOcc(occ);
        if (parsed !== null) out.push({ occ, ...parsed });
      }
    }
    return out;
  }

  /** Quotes for contracts named by OCC symbol, up to 100 to a request. Contracts the API does not return are absent. */
  async optionQuotes(occs: string[]): Promise<Map<string, OptionQuoteData>> {
    const out = new Map<string, OptionQuoteData>();
    for (const batch of chunk(occs, BATCH_QUOTES)) {
      const list = batch.map((s) => encodeURIComponent(s)).join(',');
      for (const item of this.items(await this.get(`/market-data/by-type?equity-option=${list}`))) {
        const occ = item['symbol'];
        const bid = num(item['bid']);
        const ask = num(item['ask']);
        const delta = num(item['delta']);
        if (typeof occ !== 'string' || bid === null || ask === null || delta === null) continue;
        out.set(occ, {
          bid,
          ask,
          delta,
          iv: num(item['volatility']) ?? 0,
          openInterest: num(item['open-interest']) ?? 0,
          volume: num(item['volume']) ?? 0,
        });
      }
    }
    return out;
  }
}
