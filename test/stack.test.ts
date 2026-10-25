import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The ticket Lambda is inline in infra/cloudformation.yaml (it cannot import from src/), so this reads it out of
// the template and runs it with a fake SQS client. Its ticket types are a second copy of what spread-book's
// watcher handles (TICKET_TYPES in ticket-watch.js there), checked when that repo sits next to this one.
const template = readFileSync(new URL('../infra/cloudformation.yaml', import.meta.url), 'utf8');

function lambdaSource(): string {
  const m = /FunctionName: !Sub '\$\{BucketName\}-tickets'[\s\S]*?ZipFile: \|\n([\s\S]*?)\n\n/.exec(template);
  assert.ok(m, 'the ticket Lambda moved or changed shape in infra/cloudformation.yaml');
  return (m[1] as string).replace(/^ {10}/gm, '');
}

type Reply = { statusCode: number; body: string };
const TOKEN = 'x'.repeat(40);

function loadLambda(token = TOKEN) {
  const sent: Array<Record<string, unknown>> = [];
  class SendMessageCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class SQSClient {
    async send(cmd: { input: Record<string, unknown> }) {
      sent.push(cmd.input);
      return {};
    }
  }
  const mod = { exports: {} as { handler?: (e: unknown) => Promise<Reply> } };
  const req = (name: string) => (name === '@aws-sdk/client-sqs' ? { SQSClient, SendMessageCommand } : name === 'crypto' ? require('node:crypto') : assert.fail(`unexpected require ${name}`));
  const context = vm.createContext({ require: req, exports: mod.exports, module: mod, process: { env: { TICKET_TOKEN: token, QUEUE_URL: 'https://sqs.example/q.fifo' } }, Buffer });
  vm.runInContext(lambdaSource(), context);
  const handler = mod.exports.handler as (e: unknown) => Promise<Reply>;
  const call = async (body: unknown, { method = 'POST', auth = `Bearer ${TOKEN}` } = {}) => {
    const r = await handler({ requestContext: { http: { method } }, headers: { authorization: auth }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  return { call, sent };
}
const trade = { symbol: 'SPY', side: 'put', expiration: '2026-12-04', shortStrike: 600, longStrike: 595, qty: 1 };
const ticket = (over: Record<string, unknown> = {}) => ({ id: 'b2c9f6a0-1d2e-4f00-9a1b-0123456789ab', type: 'paper.open', trade, seen: { creditMid: 1.2 }, ...over });

test('the ticket Lambda queues a paper.open ticket once, stamped with the server\'s clock', async () => {
  const { call, sent } = loadLambda();
  const r = await call(ticket());
  assert.equal(r.status, 202);
  assert.equal(sent.length, 1);
  const msg = sent[0] as { MessageBody: string; MessageGroupId: string; MessageDeduplicationId: string; QueueUrl: string };
  assert.equal(msg.MessageGroupId, 'tickets');
  assert.equal(msg.MessageDeduplicationId, ticket().id, 'a double click is one message');
  const body = JSON.parse(msg.MessageBody);
  assert.deepEqual(body.trade, trade);
  assert.deepEqual(body.seen, { creditMid: 1.2 });
  assert.ok(Math.abs(Date.parse(body.receivedAt) - Date.now()) < 5000);
});

test('the ticket Lambda checks the token, and a ping checks only that', async () => {
  const { call, sent } = loadLambda();
  assert.equal((await call(ticket(), { auth: 'Bearer wrong' })).status, 401);
  assert.equal((await call(ticket(), { auth: '' })).status, 401);
  assert.equal((await call(ticket({ type: 'ping', trade: undefined }))).status, 200);
  assert.equal(sent.length, 0);
  const short = loadLambda('too-short');
  assert.equal((await short.call(ticket(), { auth: 'Bearer too-short' })).status, 401, 'a short token is refused, even when it matches');
});

test('the ticket Lambda refuses what is not a ticket it knows', async () => {
  const { call, sent } = loadLambda();
  for (const [what, body, status] of [
    ['a GET', null, 405],
    ['not JSON', '{', 400],
    ['too large', 'x'.repeat(9000), 413],
    ['a bad id', ticket({ id: 'no' }), 400],
    ['an unknown type', ticket({ type: 'real.open' }), 400],
    ['no trade', ticket({ trade: undefined }), 400],
    ['a lowercase symbol', ticket({ trade: { ...trade, symbol: 'spy' } }), 400],
    ['another side', ticket({ trade: { ...trade, side: 'both' } }), 400],
    ['a US date', ticket({ trade: { ...trade, expiration: '12/4/26' } }), 400],
    ['a strike that is text', ticket({ trade: { ...trade, shortStrike: '600' } }), 400],
    ['too many contracts', ticket({ trade: { ...trade, qty: 11 } }), 400],
    ['seen that is not an object', ticket({ seen: 3 }), 400],
  ] as const) {
    const r = what === 'a GET' ? await call(ticket(), { method: 'GET' }) : await call(body);
    assert.equal(r.status, status, what);
  }
  assert.equal(sent.length, 0);
});

test('the stack routes /api/* to the Lambda without basic auth, and tickets/* to S3 uncached with it', () => {
  const behaviors = /CacheBehaviors: !If\n([\s\S]*?)\n        DefaultCacheBehavior:/.exec(template)?.[1] ?? '';
  const api = /PathPattern: \/api\/\*([\s\S]*?)(?=- PathPattern|$)/.exec(behaviors)?.[1] ?? '';
  const status = /PathPattern: \/tickets\/\*([\s\S]*)/.exec(behaviors)?.[1] ?? '';
  assert.match(api, /TargetOriginId: TicketOrigin/);
  assert.doesNotMatch(api, /BasicAuthFunction/, 'the Bearer token would be eaten by basic auth');
  assert.match(status, /TargetOriginId: S3Origin/);
  assert.match(status, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/, 'CachingDisabled');
  assert.match(status, /BasicAuthFunction/);
});
