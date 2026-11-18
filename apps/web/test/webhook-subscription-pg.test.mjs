// QA B-04 / PR #298 review M-1 and L-3, against a REAL Postgres.
//
// The route runs with the REAL lib/db.ts (pg Pool, db.tx = one checked-out
// client in BEGIN/COMMIT) over the migrated schema. Stripe is mocked
// (test/helpers/billing-harness.mjs; every real network call is blocked).
// The ROUTE connects as a login role that inherits stemloops_app, the role
// the app runs as, so its privileges are production's: in particular it cannot
// read auth.users (the ensureUserRow savepoint path runs for real). Setup and
// inspection use the CI superuser.
//
// This is what the in-memory fakeDb cannot prove:
//   * pg_advisory_xact_lock(hashtextextended(...)) really serialises two
//     concurrent deliveries for one subscription (the reviewer's demos);
//   * the terminal guard SQL (ON CONFLICT ... WHERE status <> 'canceled'
//     RETURNING) behaves as the route expects (L-3);
//   * nothing inside the locked transaction checks out a SECOND pool
//     connection: with the pool at max 1, such code would wait forever.
//
// Runs in CI's `Tests` job, which applies every migration to a Postgres
// service and exports DATABASE_URL before the web tests. Skipped without
// DATABASE_URL; refused for a non-local host (it writes auth.users rows).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import {
  WEB, dataUrl, PRICE, loadStripeProvider, loadWebhookRoute, makeState, envelope, deliver,
  subscriptionFixture, invoiceFixture, sentryStubUrl,
} from './helpers/billing-harness.mjs';

const URL_ = process.env.DATABASE_URL;
const LOCAL = !!URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
const skip = !URL_ ? 'DATABASE_URL not set' : !LOCAL ? 'refusing a non-local DATABASE_URL' : false;
const EMAIL_PREFIX = 'test-webhook-pg-';

const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

/** The REAL lib/db.ts (both pools), optionally with the WEBHOOK pool's size
 *  or connect timeout changed. */
async function loadRealDb({ webhookMax, webhookConnectMs } = {}) {
  const ssl = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/db-ssl.ts'), 'utf8')));
  let js = toJs(readFileSync(join(WEB, 'src/lib/db.ts'), 'utf8'))
    .replace(/from ['"]pg['"]/g, `from '${import.meta.resolve('pg')}'`)
    .replace(/from ['"]\.\/db-ssl['"]/g, `from '${ssl}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStubUrl()}'`);
  const set = (name, v) => {
    const re = new RegExp(`const ${name} = \\d+;`);
    assert.match(js, re, `db.ts ${name} moved; update this test`);
    js = js.replace(re, `const ${name} = ${v};`);
  };
  if (webhookMax) set('WEBHOOK_POOL_MAX', webhookMax);
  if (webhookConnectMs) set('WEBHOOK_POOL_CONNECT_TIMEOUT_MS', webhookConnectMs);
  return import(dataUrl(js) + '#' + Math.random());
}

const APP_ROLE = 'webhook_pg_test_app';
const APP_PW = 'webhook_pg_test_pw';
const appUrl = () => { const u = new URL(URL_); u.username = APP_ROLE; u.password = APP_PW; return u.toString(); };

let admin; // a separate pg Pool for setup / inspection (superuser)
let realDb; let sharedDb; let h; let state; let route;
let user; let cus; let subId;

const sub = (over = {}) => subscriptionFixture({ id: subId, customer: cus, metadata: { user_id: user }, ...over });
const studio = (over = {}) => sub({
  items: { object: 'list', data: [{ ...subscriptionFixture().items.data[0], price: { id: PRICE.studio, object: 'price' } }] },
  ...over,
});
const quiet = async (fn) => {
  const o = { error: console.error, warn: console.warn, info: console.info };
  console.error = console.warn = console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};
const raw = (evt) => quiet(() => deliver(route, evt, { syncStripe: false }));
const row = async () => (await admin.query(
  'SELECT status, plan_code, cancel_at_period_end FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2',
  ['stripe', subId])).rows[0];
const ent = async () => (await admin.query('SELECT plan_code FROM entitlements WHERE user_id = $1', [user])).rows[0]?.plan_code;
const retrieves = () => h.calls.filter((c) => c.api === 'subscriptions.retrieve').length;
const until = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'timed out');
};

async function cleanup() {
  await admin.query(
    `DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [EMAIL_PREFIX + '%']);
  await admin.query(
    `DELETE FROM customers_billing WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [EMAIL_PREFIX + '%']);
  await admin.query(`DELETE FROM public.users WHERE email LIKE $1`, [EMAIL_PREFIX + '%']);
  await admin.query(`DELETE FROM auth.users WHERE email LIKE $1`, [EMAIL_PREFIX + '%']);
}

/** A fresh user (auth.users -> handle_new_user trigger), customer and route.
 *  The route gets the REAL webhook pool; the real SHARED pool stands for page
 *  loads (review R2-2). */
async function fresh({ webhookMax, webhookConnectMs, transform } = {}) {
  user = randomUUID();
  cus = 'cus_pg_' + user.slice(0, 8);
  subId = 'sub_pg_' + user.slice(0, 8);
  await admin.query(
    `INSERT INTO auth.users (id, email, aud, role, encrypted_password, email_confirmed_at, created_at, updated_at)
     VALUES ($1, $2, 'authenticated', 'authenticated', 'x', now(), now(), now())`,
    [user, `${EMAIL_PREFIX}${user}@example.com`]);
  await admin.query(
    `INSERT INTO public.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [user, `${EMAIL_PREFIX}${user}@example.com`]);
  await admin.query(
    `INSERT INTO customers_billing (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2)
     ON CONFLICT DO NOTHING`, [user, cus]);
  h = await loadStripeProvider();
  state = makeState();
  route = await loadWebhookRoute(h.provider, state, { transform });
  const mod = await loadRealDb({ webhookMax, webhookConnectMs });
  realDb = mod.webhookDb;
  sharedDb = mod.db;
  globalThis.__routeDb = realDb; // the route's webhookDb stub is late-bound
  globalThis.__routeSharedDb = sharedDb; // ... and so is its shared `db`
}

before(async () => {
  if (skip) return;
  delete process.env.DATABASE_URL_POOLED;
  const pg = await import('pg');
  admin = new (pg.default?.Pool ?? pg.Pool)({ connectionString: URL_, max: 2 });
  await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}' IN ROLE stemloops_app;
      END IF;
    END $$`);
  // lib/db.ts reads DATABASE_URL when it first builds a pool: the route runs
  // with production's app privileges.
  process.env.DATABASE_URL = appUrl();
  await cleanup();
});
after(async () => {
  if (skip) return;
  process.env.DATABASE_URL = URL_;
  await cleanup();
  await admin.end();
});
beforeEach(() => { if (!skip) { globalThis.__routeDb = undefined; globalThis.__routeSharedDb = undefined; } });

test('PG: precondition: the route role cannot read auth.users (as in production)', { skip, timeout: 20000 }, async () => {
  await fresh();
  await assert.rejects(() => realDb.query('SELECT 1 FROM auth.users LIMIT 1'), /permission denied/);
});

test('PG: M-1 demo 1 (slow Pro read vs newer Studio read) ends Studio in the real DB', { skip, timeout: 20000 }, async () => {
  await fresh();
  h.subs[subId] = sub();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  const n0 = retrieves();
  h.harness.retrieveDelays.push(150);
  const a = raw(envelope('customer.subscription.updated', sub(), { cancel_at_period_end: true }));
  await until(() => retrieves() > n0);
  h.subs[subId] = studio();
  const b = raw(envelope('customer.subscription.updated', studio(), { items: { data: [{ price: { id: PRICE.pro } }] } }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200);
  assert.equal((await row()).plan_code, 'studio');
  assert.equal(await ent(), 'studio');
});

test('PG: M-1 demo 2 (created reads active, deleted runs meanwhile) leaves no phantom active row', { skip, timeout: 20000 }, async () => {
  await fresh();
  const n0 = retrieves();
  h.subs[subId] = sub();
  h.harness.retrieveDelays.push(150);
  const created = raw(envelope('customer.subscription.created', sub()));
  await until(() => retrieves() > n0);
  h.subs[subId] = sub({ status: 'canceled' });
  const deleted = raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })));
  const [rc, rd] = await Promise.all([created, deleted]);
  assert.equal(rc.status, 200); assert.equal(rd.status, 200);
  assert.equal((await row()).status, 'canceled');
  assert.notEqual(await ent(), 'pro');
});

test('PG: deleted first leaves a canceled tombstone; the real guard SQL blocks a later active write (L-3)', { skip, timeout: 20000 }, async () => {
  await fresh();
  h.subs[subId] = sub({ status: 'canceled' });
  assert.equal((await raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })))).status, 200);
  assert.deepEqual(await row(), { status: 'canceled', plan_code: 'pro', cancel_at_period_end: true });
  h.subs[subId] = sub(); // a lagging read that still says active
  assert.equal((await raw(envelope('customer.subscription.updated', sub(), { status: 'past_due' }))).status, 200);
  assert.equal((await row()).status, 'canceled');
  assert.notEqual(await ent(), 'pro');
  // A NEW subscription id (a real resubscribe) is not blocked.
  const old = subId;
  subId = 'sub_pg_new_' + user.slice(0, 6);
  h.subs[subId] = sub();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  assert.equal((await row()).status, 'active');
  assert.equal(await ent(), 'pro');
  subId = old;
});

test('PG: with the webhook pool at max 1, every locked path completes (no second checkout inside the transaction)', { skip, timeout: 20000 }, async () => {
  // A 3 s connect timeout makes a second checkout FAIL fast instead of
  // waiting for ever, so a regression is a quick red test, not a hung job.
  await fresh({ webhookMax: 1, webhookConnectMs: 3000 });
  h.subs[subId] = sub();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  h.subs[subId] = sub({ status: 'past_due' });
  assert.equal((await raw(envelope('invoice.payment_failed',
    invoiceFixture({ customer: cus, billing_reason: 'subscription_cycle', attempt_count: 1,
      parent: { type: 'subscription_details', subscription_details: { subscription: subId, metadata: {} } } })))).status, 200);
  assert.equal((await row()).status, 'past_due');
  h.subs[subId] = sub();
  assert.equal((await raw(envelope('invoice.paid', invoiceFixture({ customer: cus,
    parent: { type: 'subscription_details', subscription_details: { subscription: subId, metadata: {} } } })))).status, 200);
  h.subs[subId] = sub({ status: 'canceled' });
  assert.equal((await raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })))).status, 200);
  assert.equal((await row()).status, 'canceled');
  assert.equal(await ent(), 'free');
  await realDb.query('SELECT 1'); // the single connection was returned
});

// ---- review R2-1: the account is deleted before its `deleted` webhook ------

test('PG R2-1: account deleted first, then deleted x3 (+ a stale updated) -> 200 each, no row, no user recreated', { skip, timeout: 30000 }, async () => {
  await fresh();
  h.subs[subId] = sub();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  // DELETE /api/users/me: Stripe cancel, then auth.admin.deleteUser cascades.
  await admin.query('DELETE FROM auth.users WHERE id = $1', [user]);
  assert.equal(await row(), undefined, 'cascade precondition');
  h.subs[subId] = sub({ status: 'canceled' });
  const del = envelope('customer.subscription.deleted', sub({ status: 'canceled' }));
  for (let i = 0; i < 3; i += 1) assert.equal((await raw(del)).status, 200, `delivery ${i + 1} (Stripe would retry a 500 for ~3 days)`);
  assert.equal((await raw(envelope('customer.subscription.updated', sub(), { cancel_at_period_end: true }))).status, 200);
  assert.equal(await row(), undefined);
  assert.equal((await admin.query('SELECT 1 FROM public.users WHERE id = $1', [user])).rowCount, 0);
});

// ---- the ensureUserRow savepoint, for real (round-2 Low) ----------------------

test('PG savepoint: public.users row missing, auth.users unreadable -> created still fulfilled (derived email)', { skip, timeout: 20000 }, async () => {
  await fresh();
  // The trigger has not caught up: auth.users has the user, public.users not.
  await admin.query('DELETE FROM public.users WHERE id = $1', [user]);
  h.subs[subId] = sub();
  const res = await raw(envelope('customer.subscription.created', sub()));
  assert.equal(res.status, 200, 'the denied auth.users read aborted the locked transaction');
  const u = await admin.query('SELECT email FROM public.users WHERE id = $1', [user]);
  assert.equal(u.rows[0]?.email, `${user}@noemail.local`);
  assert.equal((await row()).status, 'active');
  assert.equal(await ent(), 'pro');
});

// ---- review R2-2: webhooks holding transactions across Stripe HTTP ---------

test('PG R2-2: three slow concurrent webhooks do not block a page-style query on the shared pool', { skip, timeout: 30000 }, async () => {
  await fresh();
  const ids = [0, 1, 2].map((i) => `${subId}_${i}`);
  for (const id of ids) h.subs[id] = sub({ id });
  h.harness.retrieveDelays.push(1500, 1500, 1500);
  const n0 = retrieves();
  const deliveries = ids.map((id) => raw(envelope('customer.subscription.created', sub({ id }))));
  await until(() => retrieves() >= n0 + 2); // two transactions are open, holding Stripe reads
  const t0 = Date.now();
  await sharedDb.query('SELECT 1');
  const waited = Date.now() - t0;
  const results = await Promise.all(deliveries);
  assert.ok(waited < 400, `a page query waited ${waited} ms behind webhook transactions`);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200], 'the third waits for a webhook-pool slot, within its timeout');
});

test('PG R2-2: webhook pool exhausted past its connect timeout -> 500 quickly (Stripe retries), not a queue', { skip, timeout: 30000 }, async () => {
  await fresh({ webhookMax: 1, webhookConnectMs: 300 });
  const ids = [0, 1].map((i) => `${subId}_x${i}`);
  for (const id of ids) h.subs[id] = sub({ id });
  h.harness.retrieveDelays.push(1500);
  const n0 = retrieves();
  const first = raw(envelope('customer.subscription.created', sub({ id: ids[0] })));
  await until(() => retrieves() > n0); // the only connection is held
  const t0 = Date.now();
  const second = await raw(envelope('customer.subscription.created', sub({ id: ids[1] })));
  const took = Date.now() - t0;
  assert.equal(second.status, 500);
  assert.ok(took < 1200, `took ${took} ms: queued instead of failing fast`);
  assert.equal((await first).status, 200);
});

// ---- review R3-1: the server ends an idle-in-transaction session -----------
// The webhook waits on Stripe inside its locked transaction. If that wait
// outlasts idle_in_transaction_session_timeout, Postgres terminates the
// session. pg then emits 'error' on the CHECKED-OUT client; with no listener
// Node raises an uncaughtException and the instance dies. db.tx must catch it
// (Sentry), and the delivery must answer 500 with nothing written.

test('PG R3-1: a locked Stripe read longer than the idle timeout -> 500, nothing written, no uncaughtException', { skip, timeout: 30000 }, async () => {
  // The route with a 1 s idle timeout (production: 20 s), so the test trips it fast.
  await fresh({ transform: (src) => {
    assert.match(src, /const IDLE_IN_TX_TIMEOUT = '20s';/);
    return src.replace(/const IDLE_IN_TX_TIMEOUT = '20s';/, "const IDLE_IN_TX_TIMEOUT = '1s';");
  } });
  const uncaught = [];
  const probe = (err) => { uncaught.push(err); };
  process.on('uncaughtException', probe);
  try {
    h.subs[subId] = sub();
    h.harness.retrieveDelays.push(2500); // the read outlasts the 1 s idle timeout
    const res = await raw(envelope('customer.subscription.created', sub()));
    await new Promise((r) => setTimeout(r, 300)); // let any late 'error' event fire
    assert.equal(res.status, 500, 'a terminated transaction must not be acked');
    assert.equal(await row(), undefined, 'nothing may be written');
    assert.deepEqual(uncaught.map((e) => e.message), [], 'pg error escaped as an uncaughtException');
    const db = state.sentry.filter((c) => c.kind === 'exception' && c.opts?.tags?.component === 'db.tx');
    assert.equal(db.length, 1, 'the dropped connection is reported to Sentry');
    assert.match(String(db[0].message?.message ?? db[0].message), /idle-in-transaction|terminat/i);
    // The broken client was destroyed, not pooled: the next delivery works.
    h.harness.retrieveDelays.length = 0;
    assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
    assert.equal((await row()).status, 'active');
  } finally {
    process.removeListener('uncaughtException', probe);
  }
});
