// QA B-04: subscription webhooks must be order-independent.
//
// Stripe does not order deliveries and retries a failed one for days. The
// route used to apply each event's PAYLOAD, so a stale
// `customer.subscription.updated (active)` retry that landed after
// `customer.subscription.deleted` turned the subscription, and the user's
// Pro/Studio entitlement, back on. The route now re-reads the subscription
// from Stripe (subscriptions.retrieve) and applies THAT.
//
// End to end: signed payload -> REAL StripeProvider.handleWebhook -> route ->
// in-memory DB. Stripe is mocked (test/helpers/billing-harness.mjs): h.subs
// is "Stripe's current state", and the harness blocks every real network
// call. Deliveries here use { syncStripe: false } so the event payload and
// Stripe's current state can disagree, which is the whole point.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE, loadStripeProvider, loadWebhookRoute, makeState, envelope, deliver,
  subscriptionFixture, invoiceFixture,
} from './helpers/billing-harness.mjs';

const USER = '11111111-1111-1111-1111-111111111111';

let h; let state; let route;
const quiet = async (fn) => {
  const o = { error: console.error, warn: console.warn, info: console.info };
  console.error = console.warn = console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};
/** Deliver exactly as Stripe would: Stripe's state is whatever h.subs says. */
const raw = (evt) => quiet(() => deliver(route, evt, { syncStripe: false }));
const sub = (over = {}) => subscriptionFixture({ metadata: { user_id: USER }, ...over });
const studio = (over = {}) => sub({
  items: { object: 'list', data: [{ ...subscriptionFixture().items.data[0], price: { id: PRICE.studio, object: 'price' } }] },
  ...over,
});
const row = () => state.subscriptions.find((s) => s.provider_subscription_id === 'sub_test_1');
const plan = () => state.entitlements.find((e) => e.user_id === USER)?.plan_code;
const retrieves = () => h.calls.filter((c) => c.api === 'subscriptions.retrieve').length;

beforeEach(async () => {
  h = await loadStripeProvider();
  state = makeState();
  state.users.push({ id: USER, email: 'payer@example.com' });
  state.customers_billing.push({ user_id: USER, provider: 'stripe', provider_customer_id: 'cus_test_1' });
  route = await loadWebhookRoute(h.provider, state);
});

// ---- the QA scenario --------------------------------------------------------

test('B-04: cancel, then a stale updated(active) retry -> stays canceled, entitlement stays free', async () => {
  // 1. Subscribed and active.
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  assert.equal(plan(), 'pro');
  // 2. An updated(active) delivery fails (DB blip) -> 500, Stripe will retry it.
  const staleActive = envelope('customer.subscription.updated', sub(), { cancel_at_period_end: true });
  state.failures.push({ re: /^INSERT INTO subscriptions/, times: 1 });
  assert.equal((await raw(staleActive)).status, 500);
  // 3. The user cancels; Stripe now holds the subscription as canceled.
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  assert.equal((await raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })))).status, 200);
  assert.equal(row().status, 'canceled');
  assert.equal(plan(), 'free');
  state.emails.length = 0;
  // 4. Stripe retries the stale updated(active).
  const before = retrieves();
  const res = await raw(staleActive);
  assert.equal(res.status, 200);
  assert.ok(retrieves() > before, 'the route must re-read the subscription from Stripe');
  assert.equal(row().status, 'canceled', 'stale retry resurrected the subscription');
  assert.equal(plan(), 'free', 'stale retry restored the paid entitlement');
  assert.deepEqual(state.emails.map((e) => e.fn), [], 'a stale event sends no email');
});

test('B-04: cancel, then a stale created(active) retry for a Studio sub -> no Studio entitlement', async () => {
  h.subs.sub_test_1 = studio();
  await raw(envelope('customer.subscription.created', studio()));
  assert.equal(plan(), 'studio');
  h.subs.sub_test_1 = studio({ status: 'canceled' });
  await raw(envelope('customer.subscription.deleted', studio({ status: 'canceled' })));
  await raw(envelope('customer.subscription.created', studio()));
  assert.equal(row().status, 'canceled');
  assert.equal(plan(), 'free');
});

// ---- out-of-order delivery ---------------------------------------------------

test('out of order: deleted arrives BEFORE the created(active) it follows -> never grants Pro', async () => {
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  assert.equal((await raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })))).status, 200);
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  assert.equal(row()?.status, 'canceled');
  assert.equal(plan(), undefined, 'no paid entitlement row was ever written');
  assert.deepEqual(state.emails.map((e) => e.fn), [], 'no welcome for a subscription that is already over');
});

test('out of order: updated(past_due) then an OLDER updated(active) -> stays past_due', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  const older = envelope('customer.subscription.updated', sub(), { status: 'incomplete' });
  h.subs.sub_test_1 = sub({ status: 'past_due' });
  await raw(envelope('customer.subscription.updated', sub({ status: 'past_due' }), { status: 'active' }));
  await raw(older);
  assert.equal(row().status, 'past_due');
});

test('out of order: Pro -> Studio, then the older Pro event arrives -> stays Studio, no "switched" email back to Pro', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  const olderPro = envelope('customer.subscription.updated', sub(), { cancel_at_period_end: true });
  h.subs.sub_test_1 = studio();
  await raw(envelope('customer.subscription.updated', studio(), { items: { data: [{ price: { id: PRICE.pro } }] } }));
  assert.equal(plan(), 'studio');
  state.emails.length = 0;
  await raw(olderPro);
  assert.equal(row().plan_code, 'studio');
  assert.equal(plan(), 'studio');
  assert.deepEqual(state.emails.map((e) => e.fn), []);
});

test('out of order: a stale "cancel at period end" event after the user resumed -> flag stays off, no R5', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  const staleEnding = envelope('customer.subscription.updated', sub({ cancel_at_period_end: true }), { cancel_at_period_end: false });
  // Resumed in the portal before staleEnding was (re)delivered.
  await raw(envelope('customer.subscription.updated', sub(), { cancel_at_period_end: true }));
  state.emails.length = 0;
  await raw(staleEnding);
  assert.equal(row().cancel_at_period_end, false);
  assert.deepEqual(state.emails.map((e) => e.fn), [], 'no "your plan is ending" for a plan that is not ending');
});

// ---- replay -----------------------------------------------------------------

test('replay: the same updated event delivered three times converges on one state and one email', async () => {
  h.subs.sub_test_1 = sub({ status: 'incomplete' });
  await raw(envelope('customer.subscription.created', sub({ status: 'incomplete' })));
  h.subs.sub_test_1 = sub();
  const evt = envelope('customer.subscription.updated', sub(), { status: 'incomplete' });
  for (let i = 0; i < 3; i += 1) assert.equal((await raw(evt)).status, 200);
  assert.equal(state.subscriptions.length, 1);
  assert.equal(row().status, 'active');
  assert.equal(plan(), 'pro');
  assert.deepEqual(state.emails.map((e) => e.fn), ['sendWelcomeIfFirstTime']);
});

test('replay: deleted delivered twice is idempotent', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  const del = envelope('customer.subscription.deleted', sub({ status: 'canceled' }));
  assert.equal((await raw(del)).status, 200);
  assert.equal((await raw(del)).status, 200);
  assert.equal(row().status, 'canceled');
  assert.equal(plan(), 'free');
});

// ---- the terminal guard (race the re-read alone leaves open) ----------------

test('race: stored row already canceled, Stripe read raced and returned active -> row stays canceled, nothing granted', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  await raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })));
  // A delivery that read Stripe BEFORE the cancel and writes AFTER it.
  h.subs.sub_test_1 = sub();
  state.emails.length = 0;
  assert.equal((await raw(envelope('customer.subscription.updated', sub(), { status: 'past_due' }))).status, 200);
  assert.equal(row().status, 'canceled');
  assert.equal(plan(), 'free');
  assert.deepEqual(state.emails.map((e) => e.fn), []);
});

// ---- failure modes of the re-read --------------------------------------------

test('Stripe read fails -> 500 (Stripe retries), nothing written; the retry applies current state', async () => {
  // No fixture: the mocked subscriptions.retrieve throws.
  const evt = envelope('customer.subscription.created', sub());
  assert.equal((await raw(evt)).status, 500);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.entitlements.length, 0);
  h.subs.sub_test_1 = sub();
  assert.equal((await raw(evt)).status, 200);
  assert.equal(plan(), 'pro');
});

test('current state carries an unknown price -> dropped with 200, nothing granted (as for the payload)', async () => {
  h.subs.sub_test_1 = sub({
    items: { object: 'list', data: [{ ...subscriptionFixture().items.data[0], price: { id: 'price_legacy', object: 'price' } }] },
  });
  const res = await raw(envelope('customer.subscription.created', sub()));
  assert.equal(res.status, 200);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.entitlements.length, 0);
});

// ---- invoice.payment_failed: same bug class --------------------------------
// A renewal fails, Stripe retries the card and it succeeds (invoice.paid),
// then the payment_failed delivery that had 500'd is retried. Applying the
// event alone left a paying subscriber past_due, and readSnapshot drops a
// past_due user to free once PAST_DUE_GRACE_MS runs out.

const cycleFailed = (over = {}) => envelope('invoice.payment_failed',
  invoiceFixture({ id: 'in_cycle_2', billing_reason: 'subscription_cycle', attempt_count: 1, ...over }));

test('payment_failed: stale failure after invoice.paid -> stays active, no R7', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  // The renewal fails; the delivery 500s, so Stripe will retry it.
  const stale = cycleFailed();
  h.subs.sub_test_1 = sub({ status: 'past_due' });
  state.failures.push({ re: /^UPDATE subscriptions SET status/, times: 1 });
  assert.equal((await raw(stale)).status, 500);
  // Stripe's own retry of the card succeeds: subscription active, invoice paid.
  h.subs.sub_test_1 = sub();
  assert.equal((await raw(envelope('invoice.paid', invoiceFixture({ id: 'in_cycle_2', billing_reason: 'subscription_cycle' })))).status, 200);
  state.emails.length = 0;
  // Now the stale payment_failed is retried. Stripe: that invoice is paid.
  h.invoices.in_cycle_2 = { id: 'in_cycle_2', object: 'invoice', status: 'paid', amount_remaining: 0 };
  const before = retrieves();
  assert.equal((await raw(stale)).status, 200);
  assert.ok(retrieves() > before, 'payment_failed must re-read the subscription from Stripe');
  assert.equal(row().status, 'active', 'a stale payment_failed marked a paid subscription past_due');
  assert.equal(plan(), 'pro');
  assert.deepEqual(state.emails.map((e) => e.fn), [], 'no "payment failed" email for a paid renewal');
});

test('payment_failed: stale failure also repairs a row an earlier delivery left past_due', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  state.subscriptions[0].status = 'past_due';
  h.invoices.in_cycle_2 = { id: 'in_cycle_2', object: 'invoice', status: 'paid', amount_remaining: 0 };
  assert.equal((await raw(cycleFailed())).status, 200);
  assert.equal(row().status, 'active');
  assert.deepEqual(state.emails.filter((e) => e.fn === 'sendPaymentFailed'), []);
});

test('payment_failed: genuine failure (Stripe says past_due) -> past_due, entitlement kept for grace, R7 once', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  state.emails.length = 0;
  state.invalidated.length = 0;
  h.subs.sub_test_1 = sub({ status: 'past_due' });
  const evt = cycleFailed();
  assert.equal((await raw(evt)).status, 200);
  assert.equal(row().status, 'past_due');
  assert.equal(plan(), 'pro', 'row kept; readSnapshot applies the grace window');
  assert.deepEqual(state.invalidated, [USER]);
  assert.deepEqual(state.emails.map((e) => e.fn), ['sendPaymentFailed']);
  assert.equal(state.emails[0].vars.provider_invoice_id, 'in_cycle_2');
});

test('payment_failed: Stripe read fails -> 500 (Stripe retries), row untouched, no R7; the retry applies', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  state.emails.length = 0;
  delete h.subs.sub_test_1; // the mocked subscriptions.retrieve now throws
  const evt = cycleFailed();
  assert.equal((await raw(evt)).status, 500);
  assert.equal(row().status, 'active', 'nothing written on a failed read');
  assert.deepEqual(state.emails.map((e) => e.fn), []);
  h.subs.sub_test_1 = sub({ status: 'past_due' });
  assert.equal((await raw(evt)).status, 200);
  assert.equal(row().status, 'past_due');
  assert.deepEqual(state.emails.map((e) => e.fn), ['sendPaymentFailed']);
});

test('payment_failed: current state carries an unknown price -> dropped with 200, row untouched', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  h.subs.sub_test_1 = sub({
    status: 'past_due',
    items: { object: 'list', data: [{ ...subscriptionFixture().items.data[0], price: { id: 'price_legacy', object: 'price' } }] },
  });
  assert.equal((await raw(cycleFailed())).status, 200);
  assert.equal(row().status, 'active');
});

// ---- review M-1: CONCURRENT deliveries -------------------------------------
// The reviewer's two demos, kept as regression tests. A mocked read is
// snapshotted when it is issued and held for `retrieveDelays` ms, so an
// older read can try to land after a newer one. The per-subscription
// advisory lock (fakeDb.tx serialises on it as Postgres would) must make the
// later delivery read AFTER the earlier one committed.

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i += 1) await tick(); assert.ok(cond(), 'timed out'); };

test('M-1 demo 1: slow Pro read vs a newer Studio read -> ends Studio (row and entitlement)', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  const n0 = retrieves();
  h.harness.retrieveDelays.push(50); // A's read is slow
  const a = raw(envelope('customer.subscription.updated', sub(), { cancel_at_period_end: true }));
  await until(() => retrieves() > n0); // A has read Pro
  h.subs.sub_test_1 = studio(); // the user upgrades
  const b = raw(envelope('customer.subscription.updated', studio(), { items: { data: [{ price: { id: PRICE.pro } }] } }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200);
  assert.equal(row().plan_code, 'studio', 'an older read was written over a newer one');
  assert.equal(plan(), 'studio');
});

test('M-1 demo 1b: slow "not ending" read vs a newer cancel_at_period_end=true -> flag stays true', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  const n0 = retrieves();
  h.harness.retrieveDelays.push(50);
  const a = raw(envelope('customer.subscription.updated', sub(), { metadata: {} }));
  await until(() => retrieves() > n0);
  h.subs.sub_test_1 = sub({ cancel_at_period_end: true });
  const b = raw(envelope('customer.subscription.updated', sub({ cancel_at_period_end: true }), { cancel_at_period_end: false }));
  await Promise.all([a, b]);
  assert.equal(row().cancel_at_period_end, true);
});

test('M-1 demo 2: created reads active (slow) while deleted runs -> canceled, never a phantom active row', async () => {
  const n0 = retrieves();
  h.subs.sub_test_1 = sub();
  h.harness.retrieveDelays.push(50);
  const created = raw(envelope('customer.subscription.created', sub()));
  await until(() => retrieves() > n0); // created has read `active`
  h.subs.sub_test_1 = sub({ status: 'canceled' }); // canceled at Stripe
  const deleted = raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })));
  const [rc, rd] = await Promise.all([created, deleted]);
  assert.equal(rc.status, 200); assert.equal(rd.status, 200);
  assert.equal(row().status, 'canceled', 'phantom active row');
  assert.notEqual(plan(), 'pro');
});

test('M-1: every subscription write path takes the per-subscription lock, keyed on provider + id', async () => {
  h.subs.sub_test_1 = sub({ status: 'past_due' });
  await raw(envelope('customer.subscription.created', sub({ status: 'past_due' })));
  await raw(cycleFailed());
  h.subs.sub_test_1 = sub();
  await raw(envelope('invoice.paid', invoiceFixture()));
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  await raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })));
  const locks = state.lockLog.filter((l) => l.key !== null);
  assert.equal(locks.length, 4, 'created, payment_failed, invoice.paid, deleted');
  for (const l of locks) {
    assert.equal(l.key, 'stripe|sub_test_1');
    assert.match(l.sql, /pg_advisory_xact_lock\(hashtextextended\(\$1 \|\| '-sub:' \|\| \$2, 0\)\)/);
  }
  // Each lock is preceded by the transaction's timeouts (review R2-2): the
  // lock wait, every statement, and idle time inside the transaction are all
  // bounded, so a stuck holder is a 500, not a hang.
  for (let i = 0; i < state.lockLog.length; i += 2) {
    assert.match(state.lockLog[i].sql,
      /set_config\('lock_timeout', \$1, true\), set_config\('statement_timeout', \$2, true\), set_config\('idle_in_transaction_session_timeout', \$3, true\)/);
    assert.deepEqual(state.lockLog[i].params, ['8s', '10s', '20s']);
    assert.notEqual(state.lockLog[i + 1].key, null);
  }
});

test('tombstone: deleted with no row stores a canceled row (no R6); a later created(active) cannot revive it', async () => {
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  await raw(envelope('customer.subscription.deleted', sub({ status: 'canceled' })));
  assert.equal(row()?.status, 'canceled', 'no tombstone');
  assert.equal(row().plan_code, 'pro');
  assert.equal(row().user_id, USER);
  assert.deepEqual(state.emails.map((e) => e.fn), [], 'a tombstone is not a plan that ended');
  // Even a read that still says active (lagging) cannot write over it.
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  assert.equal(row().status, 'canceled');
  assert.equal(plan(), undefined);
});

// ---- review R2-1: account deleted before its `deleted` webhook ---------------
// DELETE /api/users/me cancels at Stripe, then the auth.users cascade removes
// public.users, customers_billing and subscriptions. The webhook must ack:
// recreating the user would violate its FK to auth.users and 500 for ~3 days.

const deleteAccount = () => {
  state.users.length = 0;
  state.customers_billing.length = 0;
  state.subscriptions.length = 0;
  state.entitlements.length = 0;
};

test('R2-1: deleted webhook after the account was deleted -> 200 on every delivery, no tombstone, no user recreated', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  deleteAccount();
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  const del = envelope('customer.subscription.deleted', sub({ status: 'canceled' }));
  for (let i = 0; i < 3; i += 1) assert.equal((await raw(del)).status, 200, `delivery ${i + 1}`);
  assert.equal(state.subscriptions.length, 0, 'tombstone written for a user that no longer exists');
  assert.equal(state.users.length, 0, 'user row recreated');
});

test('R2-1: a stale updated retry after the account was deleted (Stripe: canceled) -> 200, nothing recreated', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  deleteAccount();
  h.subs.sub_test_1 = sub({ status: 'canceled' });
  assert.equal((await raw(envelope('customer.subscription.updated', sub(), { cancel_at_period_end: true }))).status, 200);
  assert.equal(state.users.length, 0);
  assert.equal(state.subscriptions.length, 0);
});

// ---- the ensureUserRow savepoint (round-2 Low: mutant N5 survived) ----------
// In production the app role may not read auth.users. Inside the locked
// transaction that failure aborts the transaction unless it is fenced by a
// savepoint; fakeDb.tx emulates Postgres's aborted-transaction rule.

test('savepoint: auth.users unreadable while seeding a missing user row -> still fulfilled (200)', async () => {
  state.users.length = 0; // the handle_new_user trigger has not caught up
  state.failures.push({ re: /^SELECT email FROM auth\.users/, times: 1 });
  h.subs.sub_test_1 = sub();
  const res = await raw(envelope('customer.subscription.created', sub()));
  assert.equal(res.status, 200, 'the tolerated auth.users failure aborted the transaction');
  assert.equal(state.users[0]?.email, `${USER}@noemail.local`);
  assert.equal(row()?.status, 'active');
  assert.equal(plan(), 'pro');
});

// ---- review L-2: guards no test used to notice -----------------------------

test('L-2: payment_failed when Stripe says paused -> payment_failed writes nothing (left to subscription events)', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  h.subs.sub_test_1 = sub({ status: 'paused' });
  assert.equal((await raw(cycleFailed())).status, 200);
  assert.equal(row().status, 'active');
});

test('L-2: provider returns a DIFFERENT subscription id -> 500, nothing written', async () => {
  h.subs.sub_test_1 = sub({ id: 'sub_someone_else' });
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 500);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.entitlements.length, 0);
  assert.equal((await raw(cycleFailed())).status, 500, 'payment_failed checks it too');
});

test('L-2: stale event against a stored canceled row also clears a paid entitlement left behind', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  state.subscriptions[0].status = 'canceled';
  assert.equal(plan(), 'pro', 'precondition: an entitlement the cancel did not clear');
  await raw(envelope('customer.subscription.updated', sub(), { status: 'past_due' }));
  assert.equal(plan(), 'free');
});

// ---- review L-1: payment_failed while Stripe still says active -------------

test('L-1: active subscription, invoice still OPEN with an amount due -> R7, row stays active', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  state.emails.length = 0;
  h.invoices.in_cycle_2 = { id: 'in_cycle_2', object: 'invoice', status: 'open', amount_remaining: 1200 };
  assert.equal((await raw(cycleFailed())).status, 200);
  assert.equal(row().status, 'active');
  assert.deepEqual(state.emails.map((e) => e.fn), ['sendPaymentFailed']);
});

test('L-1: active subscription, invoice voided (delayed method gave up) or paid -> no R7', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  state.emails.length = 0;
  for (const status of ['void', 'paid']) {
    h.invoices.in_cycle_2 = { id: 'in_cycle_2', object: 'invoice', status, amount_remaining: status === 'void' ? 1200 : 0 };
    assert.equal((await raw(cycleFailed())).status, 200);
  }
  assert.deepEqual(state.emails.map((e) => e.fn), []);
});

test('L-1: the invoice read fails -> 500 (Stripe retries), no R7', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  state.emails.length = 0;
  assert.equal((await raw(cycleFailed())).status, 500);
  assert.deepEqual(state.emails.map((e) => e.fn), []);
});

test('L-1: past_due needs no invoice read (card path unchanged)', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub()));
  h.subs.sub_test_1 = sub({ status: 'past_due' });
  await raw(cycleFailed());
  assert.equal(h.calls.filter((c) => c.api === 'invoices.retrieve').length, 0);
});

// ---- review L-4: an unknown price/status in a STALE payload -----------------

const legacyItems = { object: 'list', data: [{ ...subscriptionFixture().items.data[0], price: { id: 'price_legacy', object: 'price' } }] };

test('L-4: payload has an unknown price but Stripe now has a known one -> current state applied', async () => {
  h.subs.sub_test_1 = studio();
  const res = await raw(envelope('customer.subscription.created', sub({ items: legacyItems })));
  assert.equal(res.status, 200);
  assert.equal(row()?.plan_code, 'studio');
  assert.equal(plan(), 'studio');
  assert.deepEqual(state.sentry, []);
});

test('L-4: payload has an unknown status but Stripe now has a known one -> current state applied', async () => {
  h.subs.sub_test_1 = sub();
  await raw(envelope('customer.subscription.created', sub({ status: 'some_future_status' })));
  assert.equal(row()?.status, 'active');
});

test('L-4: unknown in the payload AND now -> 200, nothing written, Sentry error raised', async () => {
  h.subs.sub_test_1 = sub({ items: legacyItems });
  const res = await raw(envelope('customer.subscription.created', sub({ items: legacyItems })));
  assert.equal(res.status, 200);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.sentry.length, 1);
  assert.equal(state.sentry[0].opts.level, 'error');
  assert.match(state.sentry[0].message, /sub_test_1 not applied/);
});

test('L-4: unknown in the payload and the re-read fails -> 500 (Stripe retries)', async () => {
  const res = await raw(envelope('customer.subscription.created', sub({ items: legacyItems })));
  assert.equal(res.status, 500);
});

// ---- review I-1: livemode vs key mode ------------------------------------------

test('I-1: a LIVE event against a TEST key fails closed: 500, nothing read or written, Sentry error', async () => {
  h.subs.sub_test_1 = sub();
  const evt = { ...envelope('customer.subscription.created', sub()), livemode: true };
  const n0 = h.calls.length;
  const res = await raw(evt);
  assert.equal(res.status, 500);
  assert.equal(h.calls.length, n0, 'no Stripe read');
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.sentry.length, 1);
  assert.match(state.sentry[0].message, /mode does not match/);
});

// ---- the harness itself cannot reach Stripe ----------------------------------

test('harness: a Stripe method that is not mocked fails instead of calling api.stripe.com', async () => {
  const errs = [];
  await assert.rejects(() => h.provider.listInvoices('cus_test_1'), (err) => { errs.push(err); return true; });
  const e = errs[0];
  const text = [e?.message, e?.detail?.message, e?.raw?.message, e?.raw?.exception?.message].join(' | ');
  assert.match(text, /real Stripe network call blocked: GET api\.stripe\.com\/v1\/invoices/);
});
