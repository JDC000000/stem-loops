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
  subscriptionFixture,
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

// ---- the harness itself cannot reach Stripe ----------------------------------

test('harness: a Stripe method that is not mocked fails instead of calling api.stripe.com', async () => {
  const errs = [];
  await assert.rejects(() => h.provider.listInvoices('cus_test_1'), (err) => { errs.push(err); return true; });
  const e = errs[0];
  const text = [e?.message, e?.detail?.message, e?.raw?.message, e?.raw?.exception?.message].join(' | ');
  assert.match(text, /real Stripe network call blocked: GET api\.stripe\.com\/v1\/invoices/);
});
