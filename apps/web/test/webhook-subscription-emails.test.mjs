// Which billing email each Stripe event sends (emails v1.2 R2–R7; E1–E5).
//
// End to end through the webhook route: signed Stripe payload -> REAL
// StripeProvider.handleWebhook -> route -> in-memory DB, with the email
// dispatchers replaced by recorders (test/helpers/billing-harness.mjs). The
// sequences are built from the same fixture shapes as the fulfilment tests;
// they are not a recorded live Checkout (none is available in this repo).
//
// customer.subscription.updated carries data.previous_attributes, as Stripe
// sends it: R4/R5 are derived from the EVENT, not from our stored row, so a
// Stripe retry after a partial failure re-derives the same email (PR #272
// review B2). An update with no previous_attributes is "nothing changed".

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
const send = (type, obj, prev) => quiet(() => deliver(route, envelope(type, obj, prev)));
const update = (obj, prev) => send('customer.subscription.updated', obj, prev);
const proItems = { data: [{ price: { id: PRICE.pro } }] };
const fns = () => state.emails.map((e) => e.fn);
const sub = (over = {}) => subscriptionFixture({ metadata: { user_id: USER }, ...over });
const studio = (over = {}) => sub({
  items: { object: 'list', data: [{ ...subscriptionFixture().items.data[0], price: { id: PRICE.studio, object: 'price' } }] },
  ...over,
});

beforeEach(async () => {
  h = await loadStripeProvider();
  state = makeState();
  state.users.push({ id: USER, email: 'payer@example.com' });
  state.customers_billing.push({ user_id: USER, provider: 'stripe', provider_customer_id: 'cus_test_1' });
  route = await loadWebhookRoute(h.provider, state);
});

// ── First subscription (E3, E4) ────────────────────────────────────────

test('first Checkout: incomplete -> active -> invoice.paid sends exactly R2 + R3 ("Pro plan")', async () => {
  await send('customer.subscription.created', sub({ status: 'incomplete' }));
  assert.deepEqual(fns(), [], 'nothing while incomplete');
  await update(sub({ status: 'active' }), { status: 'incomplete' });
  h.subs.sub_test_1 = sub();
  await send('invoice.paid', invoiceFixture({ billing_reason: 'subscription_create' }));
  assert.deepEqual(fns(), ['sendWelcomeIfFirstTime', 'sendReceipt']);
  const welcome = state.emails[0].vars;
  assert.equal(welcome.plan_code, 'pro');
  assert.ok(welcome.period_end instanceof Date);
  assert.equal(state.emails[1].vars.plan_or_pack_label, 'Pro plan', 'first invoice is not a "renewal"');
});

test('first Checkout created directly as active: R2 only, no R4 in the same event', async () => {
  await send('customer.subscription.created', sub());
  assert.deepEqual(fns(), ['sendWelcomeIfFirstTime']);
});

test('declined card at Checkout: incomplete + payment_failed(subscription_create) sends nothing', async () => {
  await send('customer.subscription.created', sub({ status: 'incomplete' }));
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'subscription_create', attempt_count: 1 }));
  assert.deepEqual(fns(), []);
});

// ── Renewals and changes (E2, E3) ──────────────────────────────────────

test('renewal: an unchanged update sends nothing; invoice.paid(subscription_cycle) is a "renewal"', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await send('customer.subscription.updated', sub());
  assert.deepEqual(fns(), [], 'no R4 on a renewal');
  h.subs.sub_test_1 = sub();
  await send('invoice.paid', invoiceFixture({ billing_reason: 'subscription_cycle' }));
  assert.deepEqual(fns(), ['sendReceipt']);
  assert.equal(state.emails[0].vars.plan_or_pack_label, 'Pro plan renewal');
});

test('Pro -> Studio while active: R4 "switched" with the previous plan', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await update(studio(), { items: proItems });
  assert.deepEqual(fns(), ['sendSubscriptionChanged']);
  const v = state.emails[0].vars;
  assert.equal(v.plan_code, 'studio');
  assert.equal(v.previous_plan_code, 'pro');
  assert.equal(v.status, 'active');
});

test('portal cancellation (cancel_at_period_end -> true) sends R5, never "active, renews" (E2)', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await update(sub({ cancel_at_period_end: true }), { cancel_at_period_end: false });
  assert.deepEqual(fns(), ['sendPlanEnding']);
  assert.equal(state.emails[0].vars.plan_code, 'pro');
  assert.ok(state.emails[0].vars.period_end instanceof Date);
  // A later update that does not touch cancel_at_period_end sends nothing.
  await update(sub({ cancel_at_period_end: true }), { metadata: {} });
  assert.deepEqual(fns(), ['sendPlanEnding']);
});

test('paused then resumed: R4 "paused", then R4 "active again"', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await update(sub({ status: 'paused' }), { status: 'active' });
  await update(sub({ status: 'active' }), { status: 'paused' });
  assert.deepEqual(fns(), ['sendSubscriptionChanged', 'sendSubscriptionChanged']);
  assert.equal(state.emails[0].vars.status, 'paused');
  assert.equal(state.emails[1].vars.status, 'active');
  assert.equal(state.emails[1].vars.resumed, true);
});

test('past_due on the subscription sends nothing on upsert (R7 owns it)', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await update(sub({ status: 'past_due' }), { status: 'active' });
  assert.deepEqual(fns(), []);
});

test('past_due -> active (card fixed): R4 "active again"', async () => {
  await send('customer.subscription.created', sub());
  await update(sub({ status: 'past_due' }), { status: 'active' });
  state.emails.length = 0;
  await update(sub(), { status: 'past_due' });
  assert.deepEqual(fns(), ['sendSubscriptionChanged']);
  assert.equal(state.emails[0].vars.status, 'active');
  assert.equal(state.emails[0].vars.resumed, true);
});

test('re-subscriber (welcomed before, new subscription id): R4 "active" once, no R2', async () => {
  state.users[0].welcomed_at = '2026-01-01';
  await send('customer.subscription.created', sub({ id: 'sub_test_2' }));
  await update(sub({ id: 'sub_test_2' }), { metadata: {} });
  assert.deepEqual(fns(), ['sendSubscriptionChanged']);
  assert.equal(state.emails[0].vars.resumed, false);
  assert.equal(state.emails[0].vars.provider_subscription_id, 'sub_test_2');
});

test('stored incomplete -> active: R4 "active" only when R2 did not go out', async () => {
  state.users[0].welcomed_at = '2026-01-01';
  await send('customer.subscription.created', sub({ status: 'incomplete' }));
  await update(sub(), { status: 'incomplete' });
  assert.deepEqual(fns(), ['sendSubscriptionChanged']);
});

// ── Retry after a partial failure (review B2) ──────────────────────────
// The first delivery writes the subscription row, then a later statement
// throws: 500, Stripe retries the SAME event. A stored-row comparison would
// now see "no change" and lose the email; the event-derived one does not.

test('R5 survives a Stripe retry after the entitlement write failed', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  state.failures.push({ re: /^INSERT INTO entitlements/, times: 1 });
  const evt = envelope('customer.subscription.updated', sub({ cancel_at_period_end: true }), { cancel_at_period_end: false });
  const first = await quiet(() => deliver(route, evt));
  assert.equal(first.status, 500, 'partial failure is retried by Stripe');
  assert.equal(state.subscriptions[0].cancel_at_period_end, true, 'row already overwritten');
  assert.deepEqual(fns(), [], 'no email before every DB write succeeded');
  const retry = await quiet(() => deliver(route, evt));
  assert.equal(retry.status, 200);
  assert.deepEqual(fns(), ['sendPlanEnding']);
});

test('R6 survives a Stripe retry after the entitlement downgrade failed', async () => {
  await send('customer.subscription.created', studio());
  state.emails.length = 0;
  state.failures.push({ re: /^UPDATE entitlements SET plan_code = 'free'/, times: 1 });
  const evt = envelope('customer.subscription.deleted', studio({ status: 'canceled' }));
  const first = await quiet(() => deliver(route, evt));
  assert.equal(first.status, 500);
  assert.equal(state.subscriptions[0].status, 'canceled', 'row already canceled');
  assert.deepEqual(fns(), []);
  const retry = await quiet(() => deliver(route, evt));
  assert.equal(retry.status, 200);
  assert.deepEqual(fns(), ['sendPlanEnded']);
  assert.equal(state.emails[0].vars.plan_code, 'studio');
  assert.equal(state.emails[0].vars.on_free, true);
});

test('R6 retry with the row already stored as canceled still sends (key dedupes)', async () => {
  await send('customer.subscription.created', sub());
  await send('customer.subscription.deleted', sub({ status: 'canceled' }));
  assert.equal(state.subscriptions[0].status, 'canceled');
  state.emails.length = 0;
  await send('customer.subscription.deleted', sub({ status: 'canceled' }));
  assert.deepEqual(fns(), ['sendPlanEnded'], 'the sub-changed:<id>:canceled Resend key stops a second real send');
  assert.equal(state.emails[0].vars.provider_subscription_id, 'sub_test_1');
});

// ── Plan ended (E1) ────────────────────────────────────────────────────

test('subscription.deleted after an active plan: R6 with the stored plan, on Free', async () => {
  await send('customer.subscription.created', studio());
  state.emails.length = 0;
  await send('customer.subscription.deleted', studio({ status: 'canceled' }));
  assert.deepEqual(fns(), ['sendPlanEnded']);
  const v = state.emails[0].vars;
  assert.equal(v.plan_code, 'studio');
  assert.equal(v.on_free, true);
  assert.equal(v.provider_subscription_id, 'sub_test_1');
});

test('subscription.deleted while another subscription still entitles: R6 says not on Free', async () => {
  await send('customer.subscription.created', sub());
  await send('customer.subscription.created', sub({ id: 'sub_test_2' }));
  state.emails.length = 0;
  await send('customer.subscription.deleted', sub({ status: 'canceled' }));
  assert.deepEqual(fns(), ['sendPlanEnded']);
  assert.equal(state.emails[0].vars.on_free, false);
});

test('subscription.deleted for a never-paid (incomplete) subscription: no R6', async () => {
  await send('customer.subscription.created', sub({ status: 'incomplete' }));
  await send('customer.subscription.deleted', sub({ status: 'canceled' }));
  assert.deepEqual(fns(), []);
});

// ADV-A/B (adversarial review), through the real StripeProvider mapping.
test('ADV-A: Stripe expires an unpaid Checkout (incomplete_expired): no R6, even with no stored row status', async () => {
  await send('customer.subscription.created', sub({ status: 'incomplete' }));
  // Our row lost its incomplete status somehow (e.g. an old past_due flip):
  // the event's own status still says never paid.
  state.subscriptions[0].status = 'past_due';
  await send('customer.subscription.deleted', sub({ status: 'incomplete_expired' }));
  assert.deepEqual(fns(), []);
  assert.equal(state.subscriptions[0].status, 'canceled');
});

test('ADV-B: declined first payment does not flip incomplete to past_due, so the later expiry sends nothing', async () => {
  await send('customer.subscription.created', sub({ status: 'incomplete' }));
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'subscription_create', attempt_count: 1 }));
  assert.equal(state.subscriptions[0].status, 'incomplete', 'B1: UPDATE skips incomplete');
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'subscription_cycle', attempt_count: 1 }));
  assert.equal(state.subscriptions[0].status, 'incomplete');
  // Stripe reports the deletion with status canceled (not incomplete_expired).
  await send('customer.subscription.deleted', sub({ status: 'canceled' }));
  assert.deepEqual(fns(), []);
});

test('subscription.deleted with no stored row: no R6 (the plan is not guessed)', async () => {
  await send('customer.subscription.deleted', sub({ status: 'canceled' }));
  assert.deepEqual(fns(), []);
});

// ── Payment failed (E5) ────────────────────────────────────────────────

const lines = (start) => ({
  object: 'list',
  data: [{
    id: 'il_1', object: 'line_item',
    parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_test_1' } },
    period: { start, end: start + 30 * 24 * 3600 },
  }],
});

test('renewal payment failed: R7 with the invoice period start, attempt and next attempt', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  const start = 1_800_000_000;
  await send('invoice.payment_failed', invoiceFixture({
    billing_reason: 'subscription_cycle', attempt_count: 2, next_payment_attempt: start + 3 * 86400, lines: lines(start),
  }));
  assert.deepEqual(fns(), ['sendPaymentFailed']);
  const v = state.emails[0].vars;
  assert.equal(new Date(v.period_start).getTime(), start * 1000, 'from the invoice, not the stored row');
  assert.equal(new Date(v.next_attempt).getTime(), (start + 3 * 86400) * 1000);
  assert.equal(v.attempt_count, 2);
  assert.equal(v.provider_invoice_id, 'in_test_1');
  assert.equal(v.plan_code, 'pro');
  assert.equal(state.subscriptions[0].status, 'past_due');
});

test('payment failed without invoice lines: R7 falls back to the stored period start', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'subscription_cycle', attempt_count: 1 }));
  assert.deepEqual(fns(), ['sendPaymentFailed']);
  assert.equal(state.emails[0].vars.next_attempt, null);
  assert.ok(state.emails[0].vars.period_start instanceof Date);
});

test('payment failed with no stored subscription, or no/unknown billing_reason: no R7', async () => {
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'subscription_cycle', attempt_count: 1 }));
  assert.deepEqual(fns(), [], 'UPDATE matched no row');
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await send('invoice.payment_failed', invoiceFixture({ attempt_count: 1 }));
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'manual', attempt_count: 1 }));
  // A mid-period plan change's proration invoice is not a "renewal" (M-a).
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'subscription_update', attempt_count: 1 }));
  assert.deepEqual(fns(), []);
});
