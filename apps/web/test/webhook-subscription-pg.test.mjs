// QA B-04 / PR #298 review M-1 and L-3, against a REAL Postgres.
//
// The route runs with the REAL lib/db.ts (pg Pool, db.tx = one checked-out
// client in BEGIN/COMMIT) over the migrated schema. Stripe is mocked
// (test/helpers/billing-harness.mjs; every real network call is blocked).
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
  subscriptionFixture, invoiceFixture,
} from './helpers/billing-harness.mjs';

const URL_ = process.env.DATABASE_URL;
const LOCAL = !!URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
const skip = !URL_ ? 'DATABASE_URL not set' : !LOCAL ? 'refusing a non-local DATABASE_URL' : false;
const EMAIL_PREFIX = 'test-webhook-pg-';

const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

/** The REAL lib/db.ts, optionally with a different pool size. */
async function loadRealDb({ max } = {}) {
  const ssl = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/db-ssl.ts'), 'utf8')));
  let js = toJs(readFileSync(join(WEB, 'src/lib/db.ts'), 'utf8'))
    .replace(/from ['"]pg['"]/g, `from '${import.meta.resolve('pg')}'`)
    .replace(/from ['"]\.\/db-ssl['"]/g, `from '${ssl}'`);
  if (max) {
    assert.match(js, /max: 3,/, 'db.ts pool size moved; update this test');
    // connectionTimeoutMillis makes a second checkout FAIL in 3 s instead of
    // waiting for ever, so a regression is a quick red test, not a hung job.
    js = js.replace(/max: 3,/, `max: ${max}, connectionTimeoutMillis: 3000,`);
  }
  return import(dataUrl(js) + '#' + Math.random());
}

let admin; // a separate pg Pool for setup / inspection
let realDb; let h; let state; let route;
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

/** A fresh user (auth.users -> handle_new_user trigger), customer and route. */
async function fresh({ max } = {}) {
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
  route = await loadWebhookRoute(h.provider, state);
  realDb = (await loadRealDb({ max })).db;
  globalThis.__routeDb = realDb; // the route's db stub is late-bound
}

before(async () => {
  if (skip) return;
  delete process.env.DATABASE_URL_POOLED;
  const pg = await import('pg');
  admin = new (pg.default?.Pool ?? pg.Pool)({ connectionString: URL_, max: 2 });
  await cleanup();
});
after(async () => {
  if (skip) return;
  await cleanup();
  await admin.end();
});
beforeEach(() => { if (!skip) globalThis.__routeDb = undefined; });

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

test('PG: with the pool at max 1, every locked path completes (no second checkout inside the transaction)', { skip, timeout: 20000 }, async () => {
  await fresh({ max: 1 });
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
