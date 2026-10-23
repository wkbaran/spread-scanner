import { Http } from '../src/http.ts';
import type { Side } from '../src/types.ts';

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that answers from `handler` and records every request. */
export function fakeFetch(handler: (request: Recorded) => Response | Promise<Response>): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(request);
    return handler(request);
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

/** An Http that never sleeps, so retry tests are instant. */
export const instantHttp = (fetchFn: typeof fetch, extra: { maxAttempts?: number } = {}): Http =>
  new Http({ userAgent: 'test/1', fetch: fetchFn, sleep: async () => undefined, minIntervalMs: 0, ...extra });

/** OCC symbol: the root padded to six, YYMMDD, C or P, the strike x 1000 in eight digits. */
export function occ(root: string, expiration: string, side: Side, strike: number): string {
  const [y, m, d] = expiration.split('-');
  return `${root.padEnd(6)}${(y as string).slice(2)}${m}${d}${side === 'put' ? 'P' : 'C'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

// Standard normal CDF, Abramowitz and Stegun 7.1.26. Enough to price a synthetic chain.
function cdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return 0.5 * (1 + Math.sign(x) * (1 - poly * Math.exp(-(x * x) / 2)));
}

/** Black-Scholes price and signed delta for a synthetic chain. */
export function blackScholes(side: Side, spot: number, strike: number, sigma: number, years: number, rate = 0.04): { price: number; delta: number } {
  const sd = sigma * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * years) / sd;
  const d2 = d1 - sd;
  const discount = Math.exp(-rate * years);
  return side === 'call'
    ? { price: spot * cdf(d1) - strike * discount * cdf(d2), delta: cdf(d1) }
    : { price: strike * discount * cdf(-d2) - spot * cdf(-d1), delta: cdf(d1) - 1 };
}
