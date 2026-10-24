import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/**
 * Uploads the built report to S3 with AWS Signature Version 4, signed here with node:crypto so the
 * project keeps no runtime dependencies. It only ever PUTs: the report is a handful of fixed files,
 * so there is no listing, no sync plan and no delete, and the publish user needs nothing but PutObject.
 */

export interface S3Settings {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

/** Every object is revalidated on each request, so a new report is visible without an invalidation. */
const CACHE_CONTROL = 'no-cache';

export function s3Settings(env: Record<string, string | undefined>): S3Settings {
  const get = (key: string): string | undefined => (env[key] === undefined || env[key] === '' ? undefined : env[key]);
  const missing = ['S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((key) => get(key) === undefined);
  if (missing.length > 0) throw new Error(`Missing ${missing.join(', ')}. They come from the stack's outputs (infra/cloudformation.yaml).`);
  const sessionToken = get('AWS_SESSION_TOKEN');
  return {
    bucket: get('S3_BUCKET') as string,
    region: get('AWS_REGION') ?? 'us-east-1',
    accessKeyId: get('AWS_ACCESS_KEY_ID') as string,
    secretAccessKey: get('AWS_SECRET_ACCESS_KEY') as string,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Uint8Array, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 escaping, which is stricter than encodeURIComponent (it leaves ! ' ( ) * alone). */
const escapeSegment = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  host: string;
  /** The object path, starting with a slash; segments are escaped here, once (S3 does not escape twice). */
  path: string;
  headers: Record<string, string>;
  payload: Uint8Array | string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** The signing time as 20130524T000000Z. */
  amzDate: string;
}

/** The request's headers with `x-amz-date`, `x-amz-content-sha256` and `Authorization` added. */
export function signRequest(input: SignInput): Record<string, string> {
  const payloadHash = sha256(input.payload);
  const headers: Record<string, string> = { ...input.headers, host: input.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': input.amzDate };
  if (input.sessionToken !== undefined) headers['x-amz-security-token'] = input.sessionToken;

  const names = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  const byName = new Map(Object.entries(headers).map(([n, v]) => [n.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((n) => `${n}:${byName.get(n)}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalPath = input.path.split('/').map(escapeSegment).join('/');
  const canonicalRequest = [input.method, canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');

  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

const amzDateOf = (now: Date): string => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export async function putObject(
  settings: S3Settings,
  key: string,
  body: Uint8Array,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<void> {
  const host = `${settings.bucket}.s3.${settings.region}.amazonaws.com`;
  const path = `/${key}`;
  const headers = signRequest({
    method: 'PUT',
    host,
    path,
    headers: { 'content-type': CONTENT_TYPES[extname(key)] ?? 'application/octet-stream', 'cache-control': CACHE_CONTROL },
    payload: body,
    region: settings.region,
    service: 's3',
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    ...(settings.sessionToken === undefined ? {} : { sessionToken: settings.sessionToken }),
    amzDate: amzDateOf(now),
  });
  const response = await fetchImpl(`https://${host}${path.split('/').map(escapeSegment).join('/')}`, { method: 'PUT', headers, body });
  if (!response.ok) {
    // S3 answers with a short XML error naming the code. It carries no credentials, but keep it short anyway.
    const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`S3 refused ${key}: HTTP ${response.status} ${text}`);
  }
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));

/** Upload every file under `dir`, index.html last so the page never points at assets that are not there yet. */
export async function publishDirectory(dir: string, settings: S3Settings, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<string[]> {
  const keys = walk(dir).map((file) => ({ file, key: relative(dir, file).split('\\').join('/') }));
  keys.sort((a, b) => Number(a.key === 'index.html') - Number(b.key === 'index.html') || a.key.localeCompare(b.key));
  for (const { file, key } of keys) await putObject(settings, key, readFileSync(file), fetchImpl, now);
  return keys.map((k) => k.key);
}
