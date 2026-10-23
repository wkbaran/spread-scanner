import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Credentials {
  tastytrade: { clientSecret: string; refreshToken: string; clientId?: string; baseUrl?: string };
  fmp: { apiKey: string };
}

export const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.config', 'spread-scanner', 'credentials.env');

/** KEY=value lines; blank lines and # comments are skipped; one pair of quotes is stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Credentials from a file outside the repository, with environment variables taking precedence.
 * Errors name the missing keys and never a value.
 */
export function loadCredentials(path: string = DEFAULT_CREDENTIALS_PATH, env: Record<string, string | undefined> = process.env): Credentials {
  const fromFile = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  const get = (key: string): string | undefined => {
    const value = env[key] ?? fromFile[key];
    return value === undefined || value === '' ? undefined : value;
  };
  const missing = ['TT_CLIENT_SECRET', 'TT_REFRESH_TOKEN', 'FMP_API_KEY'].filter((key) => get(key) === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')}. Put them in ${path} (KEY=value lines) or set them in the environment.`);
  }
  const clientId = get('TT_CLIENT_ID');
  const baseUrl = get('TT_BASE_URL');
  return {
    tastytrade: {
      clientSecret: get('TT_CLIENT_SECRET') as string,
      refreshToken: get('TT_REFRESH_TOKEN') as string,
      ...(clientId === undefined ? {} : { clientId }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    },
    fmp: { apiKey: get('FMP_API_KEY') as string },
  };
}
