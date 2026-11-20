// Decision 1A: the checkout guard's SQL (lib/billing/checkout-guard.ts) against a REAL
// Postgres with every migration applied. checkout-live-sub-block.test.mjs checks the route
// through a stub DB that answers by SQL text; this file checks what the server actually
// returns for each subscriptions / entitlements shape, read AS stemloops_app (the role the
// app runs as, so RLS and grants are production's).
//
// Database: DATABASE_URL (the CI "Tests" job provides one). Everything runs in ONE
// transaction that is rolled back. Without DATABASE_URL the file skips locally, and FAILS
// under CI (CI=true), so it cannot go quietly green there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import pg from 'pg';
import { wirePureLibs } from './helpers/pure-libs.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (rel) =>
  ts.transpileModule(readFileSync(join(WEB, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const URL_ = process.env.DATABASE_URL;
if (!URL_ && process.env.CI) {
  test('checkout guard on real Postgres needs DATABASE_URL under CI', () => {
    assert.fail('DATABASE_URL is not set in CI: this real-Postgres check would not have run');
  });
}
const LOCAL = !!URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
const skip = !URL_ ? 'DATABASE_URL not set (runs in CI "Tests")' : !LOCAL ? 'refusing a non-local DATABASE_URL' : false;

let client;
let guard;

before(async () => {
  if (skip) return;
  client = new pg.Client({ connectionString: URL_ });
  await client.connect();
  await client.query('BEGIN');
  guard = await import(dataUrl(toJs('src/lib/billing/checkout-guard.ts')));
});

after(async () => {
  if (!client) return;
  await client.query('ROLLBACK');
  await client.end();
});

/** A fresh user (auth.users + public.users) inside the rolled-back transaction. */
async function freshUser() {
  const id = randomUUID();
  const email = `test-checkout-guard-${id}@example.com`;
  await client.query(
    `INSERT INTO auth.users (id, email, aud, role, encrypted_password, email_confirmed_at, created_at, updated_at)
     VALUES ($1, $2, 'authenticated', 'authenticated', 'x', now(), now(), now())`,
    [id, email],
  );
  await client.query(`INSERT INTO public.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
  return id;
}
const addSub = (user, status, { provider = 'stripe', plan = 'pro' } = {}) =>
  client.query(
    `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, plan_code, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', now() + interval '29 days')`,
    [user, provider, 'sub_guard_' + randomUUID().slice(0, 12), plan, status],
  );
const setEntitlement = (user, plan) =>
  client.query(
    `INSERT INTO entitlements (user_id, plan_code, period_start, period_end)
     VALUES ($1, $2, now() - interval '1 day', now() + interval '29 days')
     ON CONFLICT (user_id) DO UPDATE SET plan_code = EXCLUDED.plan_code`,
    [user, plan],
  );

/** The guard's read, run AS stemloops_app (SET LOCAL ROLE, reset after). */
async function check(user, provider = 'stripe') {
  await client.query('SAVEPOINT guard_read');
  await client.query('SET LOCAL ROLE stemloops_app');
  try {
    return await guard.findLiveSubscriptionInDb((sql, params) => client.query(sql, params), user, provider);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT guard_read');
  }
}

test('PG 1A: no subscription, no entitlement -> clear', { skip }, async () => {
  assert.equal(await check(await freshUser()), null);
});

for (const status of ['active', 'trialing', 'past_due', 'paused', 'incomplete']) {
  test(`PG 1A: a '${status}' subscription blocks`, { skip }, async () => {
    const u = await freshUser();
    await addSub(u, status);
    const f = await check(u);
    assert.deepEqual(f, { source: 'db_subscription', status, reason: status === 'incomplete' ? 'pending' : 'live' });
  });
}

test('PG 1A: canceled-only subscriptions are clear (may resubscribe), even with a stale paid entitlement', { skip }, async () => {
  const u = await freshUser();
  await addSub(u, 'canceled');
  await addSub(u, 'canceled', { plan: 'studio' });
  assert.equal(await check(u), null);
  await setEntitlement(u, 'pro');
  assert.equal(await check(u), null, 'a subscriptions row exists, so the entitlement is not the webhook-ordering case');
});

test('PG 1A: a paid entitlement with NO subscriptions row (webhook ordering) blocks as pending', { skip }, async () => {
  const u = await freshUser();
  await setEntitlement(u, 'studio');
  assert.deepEqual(await check(u), { source: 'db_paid_entitlement', status: 'studio', reason: 'pending' });
});

test('PG 1A: a free entitlement does not block', { skip }, async () => {
  const u = await freshUser();
  await setEntitlement(u, 'free');
  assert.equal(await check(u), null);
});

test('PG 1A: a live subscription wins over the entitlement case; canceled + active -> the active one', { skip }, async () => {
  const u = await freshUser();
  await addSub(u, 'canceled');
  await addSub(u, 'past_due', { plan: 'studio' });
  await setEntitlement(u, 'studio');
  assert.deepEqual(await check(u), { source: 'db_subscription', status: 'past_due', reason: 'live' });
});

test('PG 1A: another provider\'s live row does not block this provider; another user\'s never does', { skip }, async () => {
  const u = await freshUser();
  await addSub(u, 'active', { provider: 'paddle' });
  assert.equal(await check(u, 'stripe'), null);
  assert.equal((await check(u, 'paddle'))?.status, 'active');
  const other = await freshUser();
  await addSub(other, 'active');
  assert.equal(await check(await freshUser()), null);
});

// The route end to end on the real DB for the refusal path (it answers before the rate
// limiter's db.tx, so nothing else in the route touches the DB).
test('PG 1A: POST /api/billing/checkout with a live subscription answers 409 from the real DB; no session', { skip }, async () => {
  const u = await freshUser();
  await addSub(u, 'active');
  const calls = [];
  globalThis.__guardPg = { client, calls };
  const nextStub = dataUrl(`
    export class NextRequest {}
    export class NextResponse {
      constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
      static json(body, init = {}) { return new NextResponse(body, init); }
    }`);
  const authStub = dataUrl(`export async function getUser() { return { user_id: '${u}', email: 'x@example.com' }; }`);
  const billingStub = dataUrl(`
    export function getBillingProvider() {
      const c = globalThis.__guardPg.calls;
      return {
        name: 'stripe',
        createCustomer: async () => { c.push('createCustomer'); return { providerCustomerId: 'cus_x' }; },
        createCheckoutSession: async () => { c.push('session'); return { sessionId: 's', url: 'https://x.test' }; },
        createCreditPurchaseSession: async () => { c.push('session'); return { sessionId: 's', url: 'https://x.test' }; },
        applyPromoCode: async () => {},
      };
    }`);
  const dbStub = dataUrl(`
    export const db = {
      query: async (t, p) => {
        const { client } = globalThis.__guardPg;
        await client.query('SAVEPOINT route_read');
        await client.query('SET LOCAL ROLE stemloops_app');
        try { return await client.query(t, p); } finally { await client.query('ROLLBACK TO SAVEPOINT route_read'); }
      },
      tx: async () => { globalThis.__guardPg.calls.push('tx'); throw new Error('tx not expected on the refusal path'); },
    };`);
  const js = toJs('src/app/api/billing/checkout/route.ts')
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${dataUrl('export async function verifyHcaptchaToken() { return { success: true }; }')}'`);
  const { POST } = await import(dataUrl(wirePureLibs(js)) + '#' + Math.random());
  const warn = console.warn; console.warn = () => {};
  let res;
  try {
    res = await POST({
      headers: new Headers({ origin: 'https://stem-loops.com', host: 'stem-loops.com' }),
      json: async () => ({ plan_code: 'studio' }),
    });
  } finally { console.warn = warn; }
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PLAN_ALREADY_ACTIVE');
  assert.deepEqual(calls, [], 'no rate-limit tx, no customer, no session on a refusal');
});
