// POST /api/billing/checkout hCaptcha gate — V3-C1. Credits path requires a
// verified token; subscription path is unaffected.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const hcaptchaUrl = dataUrl(toJs(read('src/lib/hcaptcha.ts')));
const nextStub = dataUrl(`
  export class NextRequest {}
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }`);
const authStub = dataUrl(`
  export async function getUser() {
    return { user_id: '00000000-0000-0000-0000-000000000001', email: 'a@example.com' };
  }`);
const billingStub = dataUrl(`
  export function getBillingProvider() {
    return {
      name: 'stripe',
      createCustomer: async () => ({ providerCustomerId: 'cus_test' }),
      createCreditPurchaseSession: async () => {
        globalThis.__calls.push('credits');
        return { sessionId: 'cs_1', url: 'https://checkout.test/credits' };
      },
      createCheckoutSession: async () => {
        globalThis.__calls.push('subscription');
        return { sessionId: 'cs_2', url: 'https://checkout.test/sub' };
      },
      applyPromoCode: async () => {},
    };
  }`);
const dbStub = dataUrl(`
  export const db = {
    tx: async (fn) => {
      globalThis.__calls.push('ratelimit');
      return fn({ query: async (sql) => (/COUNT/.test(sql) ? { rows: [{ n: '0' }] } : { rows: [] }) });
    },
    query: async () => ({ rows: [] }),
  };`);

async function loadRoute() {
  const js = toJs(read('src/app/api/billing/checkout/route.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${hcaptchaUrl}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const makeReq = (body) => ({
  headers: new Headers({ origin: 'https://stem-loops.com', 'x-forwarded-for': '203.0.113.9' }),
  json: async () => body,
});

const realFetch = globalThis.fetch;
let verifyCalls;
function stubHcaptcha(result) {
  globalThis.fetch = async (url, init) => {
    verifyCalls.push({ url, init });
    return { ok: true, status: 200, json: async () => result };
  };
}

beforeEach(() => {
  verifyCalls = [];
  globalThis.__calls = [];
  process.env.HCAPTCHA_SECRET_KEY = '0x0000000000000000000000000000000000000000';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HCAPTCHA_SECRET_KEY;
});

test('credits: missing token -> 400 BOT_CHALLENGE_FAILED, no Stripe session', async () => {
  stubHcaptcha({ success: true });
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ pack_code: 'credits_20' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BOT_CHALLENGE_FAILED');
  assert.equal(verifyCalls.length, 0);
  assert.deepEqual(globalThis.__calls, []);
});

test('credits: invalid token -> 400 BOT_CHALLENGE_FAILED, no Stripe session', async () => {
  stubHcaptcha({ success: false, 'error-codes': ['invalid-input-response'] });
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ pack_code: 'credits_60', hcaptcha_token: 'bad' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BOT_CHALLENGE_FAILED');
  assert.equal(verifyCalls.length, 1);
  assert.equal(globalThis.__calls.includes('credits'), false);
});

test('credits: valid token -> rate limiter still runs, then credit session created', async () => {
  stubHcaptcha({ success: true });
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ pack_code: 'credits_180', hcaptcha_token: 'good' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.test/credits');
  assert.deepEqual(globalThis.__calls, ['ratelimit', 'credits']);
});

test('subscription: no token needed, hCaptcha never called', async () => {
  stubHcaptcha({ success: false });
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ plan_code: 'pro' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.test/sub');
  assert.equal(verifyCalls.length, 0);
  assert.deepEqual(globalThis.__calls, ['ratelimit', 'subscription']);
});
