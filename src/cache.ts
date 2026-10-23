import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Cache {
  /** The cached value if it is younger than `ttlMs`, else the result of `fetch`, which is then cached. */
  getOrFetch<T>(key: string, ttlMs: number, fetch: () => Promise<T>): Promise<T>;
}

/** Never caches. For tests and `--no-cache`. */
export const noCache: Cache = { getOrFetch: (_key, _ttl, fetch) => fetch() };

/**
 * One JSON file per key under `dir`, aged by the file's modification time. Slow-changing data
 * only: chain listings (about 100 KB each and 1.2 s to fetch) and calendar windows. Writes go
 * through a temporary file and a rename, so a crash never leaves half a file for the next run.
 */
export class FileCache implements Cache {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  async getOrFetch<T>(key: string, ttlMs: number, fetch: () => Promise<T>): Promise<T> {
    const file = this.path(key);
    if (existsSync(file) && this.now() - statSync(file).mtimeMs < ttlMs) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
      } catch {
        // a damaged file is just a miss
      }
    }
    const value = await fetch();
    mkdirSync(this.dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
    return value;
  }
}
