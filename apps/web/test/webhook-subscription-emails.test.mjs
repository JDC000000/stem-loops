// Which billing email each Stripe event sends (emails v1.2 R2–R7; E1–E5).
//
// End to end through the webhook route: signed Stripe payload -> REAL
// StripeProvider.handleWebhook -> route -> in-memory DB, with the email
// dispatchers replaced by recorders (test/helpers/billing-harness.mjs). The
// sequences are built from the same fixture shapes as the fulfilment tests;
// they are not a recorded live Checkout (none is available in this repo).

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
const send = (type, obj) => quiet(() => deliver(route, envelope(type, obj)));
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
  await send('customer.subscription.updated', sub({ status: 'active' }));
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
  await send('customer.subscription.updated', studio());
  assert.deepEqual(fns(), ['sendSubscriptionChanged']);
  const v = state.emails[0].vars;
  assert.equal(v.plan_code, 'studio');
  assert.equal(v.previous_plan_code, 'pro');
  assert.equal(v.status, 'active');
});

test('portal cancellation (cancel_at_period_end -> true) sends R5, never "active, renews" (E2)', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await send('customer.subscription.updated', sub({ cancel_at_period_end: true }));
  assert.deepEqual(fns(), ['sendPlanEnding']);
  assert.equal(state.emails[0].vars.plan_code, 'pro');
  assert.ok(state.emails[0].vars.period_end instanceof Date);
  // A repeat of the same state sends nothing more.
  await send('customer.subscription.updated', sub({ cancel_at_period_end: true }));
  assert.deepEqual(fns(), ['sendPlanEnding']);
});

test('paused then resumed: R4 "paused", then R4 "active again"', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await send('customer.subscription.updated', sub({ status: 'paused' }));
  await send('customer.subscription.updated', sub({ status: 'active' }));
  assert.deepEqual(fns(), ['sendSubscriptionChanged', 'sendSubscriptionChanged']);
  assert.equal(state.emails[0].vars.status, 'paused');
  assert.equal(state.emails[1].vars.status, 'active');
  assert.equal(state.emails[1].vars.resumed, true);
});

test('past_due on the subscription sends nothing on upsert (R7 owns it)', async () => {
  await send('customer.subscription.created', sub());
  state.emails.length = 0;
  await send('customer.subscription.updated', sub({ status: 'past_due' }));
  assert.deepEqual(fns(), []);
});

test('re-subscriber (welcomed before, new subscription id): R4 "active" once, no R2', async () => {
  state.users[0].welcomed_at = '2026-01-01';
  await send('customer.subscription.created', sub({ id: 'sub_test_2' }));
  await send('customer.subscription.updated', sub({ id: 'sub_test_2' }));
  assert.deepEqual(fns(), ['sendSubscriptionChanged']);
  assert.equal(state.emails[0].vars.resumed, false);
  assert.equal(state.emails[0].vars.provider_subscription_id, 'sub_test_2');
});

test('stored incomplete -> active: R4 "active" only when R2 did not go out', async () => {
  state.users[0].welcomed_at = '2026-01-01';
  await send('customer.subscription.created', sub({ status: 'incomplete' }));
  await send('customer.subscription.updated', sub());
  assert.deepEqual(fns(), ['sendSubscriptionChanged']);
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
  await send('invoice.payment_failed', invoiceFixture({ billing_reason: 'subscription_update', attempt_count: 1 }));
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
  assert.deepEqual(fns(), []);
});
