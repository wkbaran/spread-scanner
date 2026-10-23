export class HttpError extends Error {
  readonly status: number;
  /** The URL without its query string: a query can carry an API key. */
  readonly where: string;
  constructor(status: number, where: string, detail: string) {
    super(`HTTP ${status} from ${where}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'HttpError';
    this.status = status;
    this.where = where;
  }
}

export interface HttpOptions {
  userAgent: string;
  /** Smallest gap between the starts of two requests. */
  minIntervalMs?: number;
  /** Tries per request, the first included, for 429, 5xx and network errors. */
  maxAttempts?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const stripQuery = (url: string): string => url.split('?')[0] ?? url;

/**
 * Fetch JSON, paced, retrying what is worth retrying. A 429 carries no rate-limit headers on
 * tastytrade, so the only signals are the status and an optional Retry-After. Error messages
 * never contain the query string or a response body: either can hold a credential.
 */
export class Http {
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastStart = 0;

  constructor(options: HttpOptions) {
    this.userAgent = options.userAgent;
    this.minIntervalMs = options.minIntervalMs ?? 300;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async json<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<T> {
    const where = stripQuery(url);
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: init.method ?? 'GET',
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json', ...init.headers },
          ...(init.body === undefined ? {} : { body: init.body }),
        });
      } catch {
        if (attempt >= this.maxAttempts) throw new HttpError(0, where, 'network error');
        await this.sleep(this.backoff(attempt, null));
        continue;
      }
      if (response.ok) return (await response.json()) as T;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxAttempts) throw new HttpError(response.status, where, '');
      await this.sleep(this.backoff(attempt, response.headers.get('retry-after')));
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
    return 500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
  }
}
