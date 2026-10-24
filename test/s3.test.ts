import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishDirectory, putObject, s3Settings, signRequest } from '../src/s3.ts';

// AWS's documented worked examples for S3 (Signature Version 4, header-based authentication).
const EXAMPLE = {
  host: 'examplebucket.s3.amazonaws.com',
  region: 'us-east-1',
  service: 's3',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  amzDate: '20130524T000000Z',
};

const signatureOf = (headers: Record<string, string>): string => /Signature=([0-9a-f]{64})$/.exec(headers.Authorization as string)?.[1] as string;

test("AWS's documented GET Object example signs to the documented signature", () => {
  const headers = signRequest({ ...EXAMPLE, method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9' }, payload: '' });
  assert.match(headers.Authorization as string, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  assert.equal(signatureOf(headers), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test("AWS's documented PUT Object example signs to the documented signature, with $ escaped in the path", () => {
  const headers = signRequest({
    ...EXAMPLE,
    method: 'PUT',
    path: '/test$file.text',
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payload: 'Welcome to Amazon S3.',
  });
  assert.equal(signatureOf(headers), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('a session token is signed too', () => {
  const headers = signRequest({ ...EXAMPLE, method: 'GET', path: '/x', headers: {}, payload: '', sessionToken: 'tok' });
  assert.equal(headers['x-amz-security-token'], 'tok');
  assert.match(headers.Authorization as string, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
});

test('settings name the missing keys and never print a value', () => {
  assert.throws(() => s3Settings({ S3_BUCKET: 'b', AWS_SECRET_ACCESS_KEY: 'shh' }), (e: Error) => /AWS_ACCESS_KEY_ID/.test(e.message) && !/shh/.test(e.message));
  assert.deepEqual(s3Settings({ S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's' }), { bucket: 'b', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's' });
  assert.equal(s3Settings({ S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'eu-west-1' }).region, 'eu-west-1');
});

interface Seen { url: string; method: string; headers: Record<string, string>; body: string }
const recorder = (status = 200): { seen: Seen[]; fetchImpl: typeof fetch } => {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method as string, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array).toString() });
    return new Response(status === 200 ? '' : '<Error><Code>AccessDenied</Code></Error>', { status });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
};
const settings = { bucket: 'site-bucket', region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret' };

test('an upload goes to the bucket host with its type, no-cache and a signature, and never sends the secret', async () => {
  const { seen, fetchImpl } = recorder();
  await putObject(settings, 'app.js', Buffer.from('console.log(1)'), fetchImpl, new Date('2026-10-23T14:00:00Z'));
  const [req] = seen as [Seen];
  assert.equal(req.url, 'https://site-bucket.s3.us-east-1.amazonaws.com/app.js');
  assert.equal(req.method, 'PUT');
  assert.equal(req.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(req.headers['cache-control'], 'no-cache');
  assert.equal(req.headers['x-amz-date'], '20261023T140000Z');
  assert.match(req.headers.Authorization as string, /^AWS4-HMAC-SHA256 Credential=AKID\/20261023\/us-east-1\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(req.headers).includes('secret'));
  assert.equal(req.body, 'console.log(1)');
});

test('a refusal throws with the status and the S3 error, not the credentials', async () => {
  const { fetchImpl } = recorder(403);
  await assert.rejects(putObject(settings, 'index.html', Buffer.from('x'), fetchImpl), (e: Error) => /index\.html: HTTP 403/.test(e.message) && /AccessDenied/.test(e.message) && !/secret|AKID/.test(e.message));
});

test('a directory goes up with index.html last, subdirectories keep their path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-s3-'));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'index.html'), '<html>');
    writeFileSync(join(dir, 'model.js'), 'm');
    writeFileSync(join(dir, 'sub', 'a.css'), 'a');
    const { seen, fetchImpl } = recorder();
    const keys = await publishDirectory(dir, settings, fetchImpl);
    assert.deepEqual(keys, ['model.js', 'sub/a.css', 'index.html']);
    assert.deepEqual(seen.map((s) => s.url.split('amazonaws.com/')[1]), ['model.js', 'sub/a.css', 'index.html']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
