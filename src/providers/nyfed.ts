import type { Http } from '../http.ts';

const SOFR_URL = 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json';

export interface Sofr {
  /** The rate as a fraction: 0.039 for 3.90%. */
  rate: number;
  /** The day the rate applies to (SOFR is published the morning after). */
  date: string;
}

/** The New York Fed's public rate API: no key, no account. */
export class NyFed {
  private readonly http: Http;

  constructor(http: Http) {
    this.http = http;
  }

  /** The most recent Secured Overnight Financing Rate. */
  async sofr(): Promise<Sofr> {
    const body = await this.http.json<{ refRates?: Array<{ effectiveDate?: unknown; percentRate?: unknown; type?: unknown }> }>(SOFR_URL);
    const latest = body.refRates?.[0];
    const percent = Number(latest?.percentRate);
    if (latest === undefined || latest.type !== 'SOFR' || !Number.isFinite(percent) || typeof latest.effectiveDate !== 'string') {
      throw new Error('the New York Fed did not return a SOFR rate');
    }
    return { rate: percent / 100, date: latest.effectiveDate };
  }
}
