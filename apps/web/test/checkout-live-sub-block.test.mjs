// Decision 1A (2026-11-19): POST /api/billing/checkout refuses a SECOND plan checkout
// while the user has a live subscription. #301 only hid the button on /pricing; a direct
// POST still opened a second Stripe subscription (Pro -> Studio double billing). Plan
// changes go through the customer portal. Credit packs are never blocked.
//
// The route is loaded with the REAL lib/billing/checkout-guard.ts (via pure-libs) and a
// stub DB that answers the guard's SQL from a table of rows per test. The provider is a
// stub; StripeProvider.listLiveSubscriptions itself is tested further down through the
// shared billing harness (real StripeProvider, network blocked).
// The guard's SQL against a REAL Postgres: test/checkout-live-sub-pg.test.mjs (CI).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { wirePureLibs } from './helpers/pure-libs.mjs';
import { loadStripeProvider } from './helpers/billing-harness.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const guard = await import(dataUrl(toJs(read('src/lib/billing/checkout-guard.ts'))));
const { ERROR_COPY } = await import(dataUrl(toJs(read('src/lib/error-copy.ts'))));

const USER = '00000000-0000-0000-0000-000000000001';

const hcaptchaStub = dataUrl(`export async function verifyHcaptchaToken() { return { success: true }; }`);
const nextStub = dataUrl(`
  export class NextRequest {}
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }`);
const authStub = dataUrl(`
  export async function getUser() { return { user_id: '${USER}', email: 'a@example.com' }; }`);
// The provider records every call; listLiveSubscriptions is present unless
// globalThis.__noList is set (a provider without it, e.g. Paddle).
const billingStub = dataUrl(`
  export function getBillingProvider() {
    const t = globalThis.__t;
    const p = {
      name: 'stripe',
      createCustomer: async () => { t.calls.push('createCustomer'); return { providerCustomerId: 'cus_new' }; },
      createCreditPurchaseSession: async () => { t.calls.push('pack-session'); return { sessionId: 'cs_p', url: 'https://checkout.test/pack' }; },
      createCheckoutSession: async () => { t.calls.push('plan-session'); return { sessionId: 'cs_s', url: 'https://checkout.test/plan' }; },
      applyPromoCode: async () => {},
    };
    if (!t.noList) {
      p.listLiveSubscriptions = async (customerId) => {
        t.calls.push('list:' + customerId);
        if (t.listError) throw t.listError;
        return t.providerSubs;
      };
    }
    return p;
  }`);
// The guard's query is told apart by its text; the rate limiter runs in db.tx.
const dbStub = dataUrl(`
  export const db = {
    tx: async (fn) => {
      globalThis.__t.calls.push('ratelimit');
      return fn({ query: async (sql) => (/COUNT/.test(sql) ? { rows: [{ n: '0' }] } : { rows: [] }) });
    },
    query: async (sql, params) => {
      const t = globalThis.__t;
      if (/FROM subscriptions s/.test(sql)) {
        t.calls.push('guard-db');
        t.guardParams = params;
        if (t.dbError) throw t.dbError;
        return { rows: t.guardRows };
      }
      if (/FROM customers_billing/.test(sql)) {
        return { rows: t.storedCustomer ? [{ provider_customer_id: t.storedCustomer }] : [] };
      }
      return { rows: [] };
    },
  };`);

async function loadRoute() {
  const js = toJs(read('src/app/api/billing/checkout/route.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${hcaptchaStub}'`);
  return import(dataUrl(wirePureLibs(js)) + '#' + Math.random());
}

const makeReq = (body) => ({
  headers: new Headers({ origin: 'https://stem-loops.com', host: 'stem-loops.com' }),
  json: async () => body,
});
const quiet = async (fn) => {
  const o = { error: console.error, warn: console.warn };
  console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};
const post = async (body) => quiet(async () => (await loadRoute()).POST(makeReq(body)));
const PLAN = { plan_code: 'studio' };
const PACK = { pack_code: 'credits_20', hcaptcha_token: 't' };
const sessions = () => globalThis.__t.calls.filter((c) => c.endsWith('-session'));

beforeEach(() => {
  globalThis.__t = {
    calls: [], guardRows: [], guardParams: null, dbError: null,
    storedCustomer: 'cus_stored', providerSubs: [], listError: null, noList: false,
  };
});

// ── the DB check ──────────────────────────────────────────────────────────────

for (const status of ['active', 'trialing', 'past_due', 'paused', 'incomplete']) {
  test(`1A: a plan checkout with a DB subscription in '${status}' is refused 409 PLAN_ALREADY_ACTIVE, no session`, async () => {
    globalThis.__t.guardRows = [{ source: 'db_subscription', status }];
    const res = await post(PLAN);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PLAN_ALREADY_ACTIVE');
    assert.equal(res.body.manage_url, '/account');
    assert.equal(res.body.reason, status === 'incomplete' ? 'pending' : 'live');
    assert.deepEqual(sessions(), [], 'no checkout session may be created');
    assert.ok(!globalThis.__t.calls.includes('ratelimit'), 'a refusal must not burn a rate-limit slot');
    assert.ok(!globalThis.__t.calls.some((c) => c.startsWith('list:')), 'the DB answer is enough');
  });
}

test('1A: the live copy points at managing the plan on /account; pending says it is being set up', async () => {
  globalThis.__t.guardRows = [{ source: 'db_subscription', status: 'active' }];
  const live = await post(PLAN);
  assert.equal(live.body.error, 'You already have a plan. To change or cancel it, use Manage subscription on your Account page.');
  globalThis.__t.guardRows = [{ source: 'db_paid_entitlement', status: 'pro' }];
  const pending = await post(PLAN);
  assert.equal(pending.status, 409);
  assert.equal(pending.body.reason, 'pending');
  assert.equal(pending.body.error, 'Your plan is still being set up. Give it a minute, then manage it from your Account page.');
});

test('1A: the guard asks the DB for exactly the live statuses (canceled is not one), for this user and provider', async () => {
  await post(PLAN);
  const [uid, provider, statuses] = globalThis.__t.guardParams;
  assert.equal(uid, USER);
  assert.equal(provider, 'stripe');
  assert.deepEqual(statuses, ['active', 'trialing', 'past_due', 'paused', 'incomplete']);
  assert.ok(!statuses.includes('canceled'));
});

test('1A: DB clear (no rows, e.g. canceled-only) -> the plan checkout proceeds', async () => {
  const res = await post(PLAN);
  assert.equal(res.status, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.test/plan');
  assert.deepEqual(sessions(), ['plan-session']);
});

test('1A: a failed DB read is a 502 CHECKOUT_FAILED, never "clear"', async () => {
  globalThis.__t.dbError = new Error('connection refused');
  const res = await post(PLAN);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'CHECKOUT_FAILED');
  assert.deepEqual(sessions(), []);
});

// ── credit packs are never blocked ───────────────────────────────────────────

test('1A: a credit-pack checkout with a live subscription goes through; neither check runs', async () => {
  globalThis.__t.guardRows = [{ source: 'db_subscription', status: 'active' }];
  globalThis.__t.providerSubs = [{ id: 'sub_x', status: 'active' }];
  const res = await post(PACK);
  assert.equal(res.status, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.test/pack');
  assert.ok(!globalThis.__t.calls.includes('guard-db'));
  assert.ok(!globalThis.__t.calls.some((c) => c.startsWith('list:')));
  assert.deepEqual(sessions(), ['pack-session']);
});

test('1A: a credit-pack checkout goes through even when the guard read would fail', async () => {
  globalThis.__t.dbError = new Error('boom');
  globalThis.__t.listError = new Error('boom');
  const res = await post(PACK);
  assert.equal(res.status, 200);
});

// ── the stale-sync fallback (Checkout completed, webhook not landed) ──────────

test('1A: DB clear but the stored customer has a live Stripe subscription -> 409 pending, no session', async () => {
  globalThis.__t.providerSubs = [{ id: 'sub_just_paid', status: 'active' }];
  const res = await post(PLAN);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PLAN_ALREADY_ACTIVE');
  assert.equal(res.body.reason, 'pending');
  assert.ok(globalThis.__t.calls.includes('list:cus_stored'));
  assert.deepEqual(sessions(), []);
});

test('1A: DB clear and Stripe lists nothing live -> checkout proceeds after one list call', async () => {
  const res = await post(PLAN);
  assert.equal(res.status, 200);
  assert.deepEqual(globalThis.__t.calls.filter((c) => c.startsWith('list:')), ['list:cus_stored']);
});

test('1A: a failed Stripe list is a 502 CHECKOUT_FAILED, never "clear"', async () => {
  globalThis.__t.listError = new Error('Request timed out');
  const res = await post(PLAN);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'CHECKOUT_FAILED');
  assert.deepEqual(sessions(), []);
});

test('1A: no stored customer (minted in this request) -> no Stripe list; it cannot own a subscription', async () => {
  globalThis.__t.storedCustomer = null;
  globalThis.__t.providerSubs = [{ id: 'sub_x', status: 'active' }];
  const res = await post(PLAN);
  assert.equal(res.status, 200);
  assert.ok(globalThis.__t.calls.includes('createCustomer'));
  assert.ok(!globalThis.__t.calls.some((c) => c.startsWith('list:')));
});

test('1A: a provider without listLiveSubscriptions gets the DB check only', async () => {
  globalThis.__t.noList = true;
  assert.equal((await post(PLAN)).status, 200);
  globalThis.__t.calls = [];
  globalThis.__t.guardRows = [{ source: 'db_subscription', status: 'active' }];
  assert.equal((await post(PLAN)).status, 409);
});

// ── the guard module on its own ──────────────────────────────────────────────

test('1A: the guard live statuses are the /pricing ones (pricing-plan-state.ts), so both agree on "live"', () => {
  const src = read('src/lib/billing/pricing-plan-state.ts');
  const m = src.match(/LIVE_SUBSCRIPTION_STATUSES = \[([^\]]*)\]/);
  assert.ok(m, 'pricing-plan-state.ts LIVE_SUBSCRIPTION_STATUSES moved; update this test');
  const pricing = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...guard.CHECKOUT_LIVE_STATUSES].sort(), pricing.sort());
});

test('1A: ERROR_COPY.PLAN_ALREADY_ACTIVE is the guard live copy; both copies are one sentence + one sentence', () => {
  assert.deepEqual(ERROR_COPY.PLAN_ALREADY_ACTIVE, { ...guard.PLAN_ALREADY_ACTIVE_COPY.live });
  const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
  for (const [k, c] of Object.entries(guard.PLAN_ALREADY_ACTIVE_COPY)) {
    assert.equal(sentences(c.headline).length, 1, k);
    assert.equal(sentences(c.action).length, 1, k);
    assert.match(c.action, /Account page/, `${k}: must point at where the plan is managed`);
  }
});

test('1A: findLiveSubscriptionInDb maps rows; an empty result is clear; an error propagates', async () => {
  const q = (rows) => async () => ({ rows });
  assert.equal(await guard.findLiveSubscriptionInDb(q([]), USER, 'stripe'), null);
  assert.deepEqual(await guard.findLiveSubscriptionInDb(q([{ source: 'db_subscription', status: 'past_due' }]), USER, 'stripe'),
    { source: 'db_subscription', status: 'past_due', reason: 'live' });
  assert.deepEqual(await guard.findLiveSubscriptionInDb(q([{ source: 'db_paid_entitlement', status: 'studio' }]), USER, 'stripe'),
    { source: 'db_paid_entitlement', status: 'studio', reason: 'pending' });
  await assert.rejects(() => guard.findLiveSubscriptionInDb(async () => { throw new Error('x'); }, USER, 'stripe'), /x/);
});

test('1A: findingFromProvider: none -> null; any -> pending', () => {
  assert.equal(guard.findingFromProvider([]), null);
  assert.deepEqual(guard.findingFromProvider([{ id: 's', status: 'trialing' }]), { source: 'provider', status: 'trialing', reason: 'pending' });
});

// ── StripeProvider.listLiveSubscriptions (real provider, network blocked) ────

test('1A: StripeProvider.listLiveSubscriptions lists the customer, drops canceled/incomplete_expired, keeps the rest', async () => {
  const h = await loadStripeProvider();
  h.harness.subsList = [
    { id: 'sub_a', status: 'active' },
    { id: 'sub_c', status: 'canceled' },
    { id: 'sub_e', status: 'incomplete_expired' },
    { id: 'sub_u', status: 'unpaid' },
    { id: 'sub_p', status: 'paused' },
    { id: 'sub_new', status: 'some_future_status' },
  ];
  const live = await h.provider.listLiveSubscriptions('cus_1');
  assert.deepEqual(live.map((s) => s.id), ['sub_a', 'sub_u', 'sub_p', 'sub_new'], 'an unknown status counts as live (fail safe)');
  const call = h.calls.find((c) => c.api === 'subscriptions.list');
  assert.equal(call.params.customer, 'cus_1');
  assert.equal('status' in call.params, false, 'no status filter: Stripe then lists every non-canceled subscription');
  assert.deepEqual(call.ropts, { timeout: 5000, maxNetworkRetries: 0 }, 'bounded read (#298)');
});

test('1A: StripeProvider.listLiveSubscriptions: the REAL SDK sends the 5 s timeout and fails (throws) on a network error', async () => {
  const h = await loadStripeProvider();
  h.harness.passthrough = true;
  await assert.rejects(() => h.provider.listLiveSubscriptions('cus_1'));
  const attempts = h.harness.netAttempts.filter((a) => a.path.startsWith('/v1/subscriptions'));
  assert.ok(attempts.length >= 1 && attempts.length <= 2, `attempts: ${attempts.length}`);
  for (const a of attempts) assert.equal(a.timeout, 5000);
});
