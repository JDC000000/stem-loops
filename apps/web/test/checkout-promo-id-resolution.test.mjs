// M7 (credit-ledger review 2026-11-03): checkout resolves the Stripe
// promotion_code id and passes it to the provider (-> session metadata).
// Unknown/inactive code -> null -> checkout still succeeds without it.

import { test, beforeEach } from 'node:test';
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

const hcaptchaStub = dataUrl(`export async function verifyHcaptchaToken() { return { success: true }; }`);
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
// The stub provider mirrors StripeProvider's metadata threading: it records
// the metadata a real session.create would receive.
const billingStub = dataUrl(`
  function build(promoCode, promoCodeId) {
    const metadata = { user_id: 'u' };
    if (promoCode) metadata.promo_code = promoCode;
    if (promoCodeId) metadata.stripe_promotion_code_id = promoCodeId;
    globalThis.__sessionCreates.push({ metadata });
    return { sessionId: 'cs_1', url: 'https://checkout.test/x' };
  }
  export function getBillingProvider() {
    return {
      name: 'stripe',
      createCustomer: async () => ({ providerCustomerId: 'cus_test' }),
      createCreditPurchaseSession: async (_u, _p, _s, _c, promoCode, promoCodeId) => build(promoCode, promoCodeId),
      createCheckoutSession: async (_u, _p, _s, _c, promoCode, promoCodeId) => build(promoCode, promoCodeId),
      applyPromoCode: async () => {},
      resolvePromotionCodeId: async (code) => {
        globalThis.__resolveCalls.push(code);
        return globalThis.__resolveResult;
      },
    };
  }`);
const dbStub = dataUrl(`
  export const db = {
    tx: async (fn) => fn({ query: async (sql) => (/COUNT/.test(sql) ? { rows: [{ n: '0' }] } : { rows: [] }) }),
    query: async () => ({ rows: [] }),
  };`);

async function loadRoute() {
  const js = toJs(read('src/app/api/billing/checkout/route.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${hcaptchaStub}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const makeReq = (body) => ({
  headers: new Headers({ origin: 'https://stem-loops.com' }),
  json: async () => body,
});

beforeEach(() => {
  globalThis.__sessionCreates = [];
  globalThis.__resolveCalls = [];
  globalThis.__resolveResult = null;
});

test('promo_code resolves -> session metadata carries stripe_promotion_code_id', async () => {
  globalThis.__resolveResult = 'promo_abc';
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ plan_code: 'pro', promo_code: 'SAVE10' }));
  assert.equal(res.status, 200);
  assert.deepEqual(globalThis.__resolveCalls, ['SAVE10']);
  assert.equal(globalThis.__sessionCreates.length, 1);
  assert.equal(globalThis.__sessionCreates[0].metadata.stripe_promotion_code_id, 'promo_abc');
  assert.equal(globalThis.__sessionCreates[0].metadata.promo_code, 'SAVE10');
});

test('credit pack with promo_code also gets the resolved id', async () => {
  globalThis.__resolveResult = 'promo_abc';
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ pack_code: 'credits_20', promo_code: 'SAVE10', hcaptcha_token: 't' }));
  assert.equal(res.status, 200);
  assert.equal(globalThis.__sessionCreates[0].metadata.stripe_promotion_code_id, 'promo_abc');
});

test('promo_code not found -> no promo id in metadata, request still succeeds', async () => {
  globalThis.__resolveResult = null;
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ plan_code: 'pro', promo_code: 'NOPE' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.test/x');
  assert.equal('stripe_promotion_code_id' in globalThis.__sessionCreates[0].metadata, false);
});

test('no promo_code -> resolver not called', async () => {
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ plan_code: 'pro' }));
  assert.equal(res.status, 200);
  assert.deepEqual(globalThis.__resolveCalls, []);
  assert.equal('stripe_promotion_code_id' in globalThis.__sessionCreates[0].metadata, false);
});
