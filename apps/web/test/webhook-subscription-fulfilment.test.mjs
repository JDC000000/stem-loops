// End-to-end through the webhook route: signed Stripe payload -> REAL
// StripeProvider.handleWebhook (real constructEvent) -> route -> in-memory DB.
// Covers: fulfilment when metadata is empty (customer fallback), loud failure
// on unattributable payments, entitlement downgrade on cancel / unpaid, and
// dispute clawback.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE, loadStripeProvider, loadWebhookRoute, makeState, envelope, deliver,
  subscriptionFixture, invoiceFixture, creditSessionFixture, disputeFixture,
} from './helpers/billing-harness.mjs';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

let h; let state; let route;
const silence = () => {
  const o = { error: console.error, warn: console.warn, info: console.info };
  console.error = console.warn = console.info = () => {};
  return () => Object.assign(console, o);
};

beforeEach(async () => {
  h = await loadStripeProvider();
  state = makeState();
  state.users.push({ id: USER, email: 'payer@example.com' });
  // checkout/route.ts stores this BEFORE creating the session.
  state.customers_billing.push({ user_id: USER, provider: 'stripe', provider_customer_id: 'cus_test_1' });
  route = await loadWebhookRoute(h.provider, state);
});

// ---- Defect 1: subscription events resolve the user ------------------------

test('subscription.created WITH subscription metadata: subscription + pro entitlement written', async () => {
  const res = await deliver(route, envelope('customer.subscription.created',
    subscriptionFixture({ metadata: { user_id: USER, plan_code: 'pro' } })));
  assert.equal(res.status, 200);
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.subscriptions[0].user_id, USER);
  assert.equal(state.entitlements[0]?.plan_code, 'pro');
});

test('subscription.created with EMPTY metadata: resolved via customers_billing, still fulfilled', async () => {
  const res = await deliver(route, envelope('customer.subscription.created', subscriptionFixture()));
  assert.equal(res.status, 200);
  assert.equal(state.subscriptions.length, 1, 'subscription row must be written');
  assert.equal(state.subscriptions[0].user_id, USER);
  assert.equal(state.entitlements[0]?.plan_code, 'pro');
  assert.equal(state.entitlements[0]?.user_id, USER);
});

test('subscription.created, empty metadata, UNKNOWN customer: 500 (Stripe retries), nothing written', async () => {
  const restore = silence();
  let res;
  try {
    res = await deliver(route, envelope('customer.subscription.created',
      subscriptionFixture({ customer: 'cus_stranger' })));
  } finally { restore(); }
  assert.equal(res.status, 500, 'must not ack a payment we cannot attribute');
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.entitlements.length, 0);
});

test('invoice.paid, no metadata, no subscriptions row yet: resolved via customer, entitlement refreshed', async () => {
  h.subs.sub_test_1 = subscriptionFixture();
  const res = await deliver(route, envelope('invoice.paid', invoiceFixture()));
  assert.equal(res.status, 200);
  assert.equal(state.entitlements[0]?.plan_code, 'pro');
  assert.equal(state.entitlements[0]?.user_id, USER);
});

test('invoice.paid for an unattributable customer: 500, not a silent 200', async () => {
  h.subs.sub_test_1 = subscriptionFixture({ customer: 'cus_stranger' });
  const restore = silence();
  let res;
  try {
    res = await deliver(route, envelope('invoice.paid', invoiceFixture({ customer: 'cus_stranger' })));
  } finally { restore(); }
  assert.equal(res.status, 500);
  assert.equal(state.entitlements.length, 0);
});

// ---- Defect 3: entitlements follow subscription state ----------------------

test('subscription.updated status=incomplete (unpaid) grants NO entitlement', async () => {
  const res = await deliver(route, envelope('customer.subscription.updated',
    subscriptionFixture({ status: 'incomplete', metadata: { user_id: USER } })));
  assert.equal(res.status, 200);
  assert.equal(state.subscriptions[0].status, 'incomplete');
  assert.equal(state.entitlements.length, 0, 'an unpaid subscription must not grant Pro');
});

test('subscription.deleted downgrades the entitlement row to free', async () => {
  await deliver(route, envelope('customer.subscription.created', subscriptionFixture({ metadata: { user_id: USER } })));
  assert.equal(state.entitlements[0].plan_code, 'pro');
  const res = await deliver(route, envelope('customer.subscription.deleted', subscriptionFixture({ status: 'canceled' })));
  assert.equal(res.status, 200);
  assert.equal(state.subscriptions[0].status, 'canceled');
  assert.equal(state.entitlements[0].plan_code, 'free');
  assert.ok(state.invalidated.includes(USER));
});

test('subscription.deleted does NOT downgrade while another subscription still entitles the user', async () => {
  await deliver(route, envelope('customer.subscription.created', subscriptionFixture({ metadata: { user_id: USER } })));
  await deliver(route, envelope('customer.subscription.created',
    subscriptionFixture({ id: 'sub_test_2', metadata: { user_id: USER } })));
  await deliver(route, envelope('customer.subscription.deleted', subscriptionFixture({ status: 'canceled' })));
  assert.equal(state.entitlements[0].plan_code, 'pro');
});

test('subscription.updated status=canceled downgrades to free', async () => {
  await deliver(route, envelope('customer.subscription.created', subscriptionFixture({ metadata: { user_id: USER } })));
  await deliver(route, envelope('customer.subscription.updated',
    subscriptionFixture({ status: 'incomplete_expired', metadata: { user_id: USER } })));
  assert.equal(state.entitlements[0].plan_code, 'free');
});

test('invoice.payment_failed marks past_due and invalidates the cache for the real user (no metadata)', async () => {
  await deliver(route, envelope('customer.subscription.created', subscriptionFixture({ metadata: { user_id: USER } })));
  state.invalidated.length = 0;
  const res = await deliver(route, envelope('invoice.payment_failed', invoiceFixture()));
  assert.equal(res.status, 200);
  assert.equal(state.subscriptions[0].status, 'past_due');
  assert.deepEqual(state.invalidated, [USER]);
  assert.equal(state.entitlements[0].plan_code, 'pro', 'row kept; readSnapshot applies the grace window');
});

// ---- Defect 4: paid credit purchase must never be dropped with a 200 -------

test('credit purchase with EMPTY metadata.user_id: resolved via session.customer, credits granted', async () => {
  const res = await deliver(route, envelope('checkout.session.completed', creditSessionFixture()));
  assert.equal(res.status, 200);
  assert.equal(state.credit_purchases.length, 1);
  assert.equal(state.credit_purchases[0].user_id, USER);
  assert.equal(state.credit_purchases[0].credits_granted, 180);
});

test('credit purchase, no metadata, unknown customer, matching customer_email: resolved via email', async () => {
  const res = await deliver(route, envelope('checkout.session.completed',
    creditSessionFixture({ customer: 'cus_stranger', customer_email: 'payer@example.com' })));
  assert.equal(res.status, 200);
  assert.equal(state.credit_purchases[0]?.user_id, USER);
});

test('credit purchase nobody can be found for: 500 + error log, no row (never a silent 200)', async () => {
  const errors = [];
  const o = { error: console.error, warn: console.warn };
  console.error = (...a) => errors.push(a.join(' '));
  console.warn = () => {};
  let res;
  try {
    res = await deliver(route, envelope('checkout.session.completed',
      creditSessionFixture({ customer: 'cus_stranger', customer_details: { email: 'nobody@example.com' } })));
  } finally { Object.assign(console, o); }
  assert.equal(res.status, 500);
  assert.equal(state.credit_purchases.length, 0);
  assert.ok(errors.some((e) => /UNFULFILLED PAYMENT/.test(e)), 'must be logged at error level');
});

// ---- Defect 5: disputes claw back credits ----------------------------------

const seedPurchase = () => state.credit_purchases.push({
  user_id: USER, provider: 'stripe', provider_charge_id: 'pi_test_1', pack_code: 'credits_180',
  credits_granted: 180, amount_cad_cents: 3000,
});

test('charge.dispute.created claws back the full 180 credits', async () => {
  seedPurchase();
  const res = await deliver(route, envelope('charge.dispute.created', disputeFixture()));
  assert.equal(res.status, 200);
  assert.equal(state.adjustments.length, 1);
  assert.equal(state.adjustments[0].credits_delta, -180);
  assert.equal(state.adjustments[0].user_id, USER);
  assert.equal(state.usage.length, 1);
});

test('dispute redelivery (same event id) is idempotent', async () => {
  seedPurchase();
  const env = envelope('charge.dispute.created', disputeFixture());
  await deliver(route, env);
  const res = await deliver(route, env);
  assert.equal(res.status, 200);
  assert.equal(state.adjustments.length, 1);
  assert.equal(state.usage.length, 1);
});

test('dispute after a partial refund claws back only the remainder (never exceeds credits granted)', async () => {
  seedPurchase();
  state.adjustments.push({ user_id: USER, credits_delta: -90, reason: 'refund', provider: 'stripe',
    provider_event_id: 'evt_refund', provider_charge_id: 'pi_test_1' });
  await deliver(route, envelope('charge.dispute.created', disputeFixture()));
  const total = state.adjustments.reduce((n, a) => n - a.credits_delta, 0);
  assert.equal(total, 180);
});

test('dispute on a non-credit charge is a no-op 200', async () => {
  const res = await deliver(route, envelope('charge.dispute.created', disputeFixture({ payment_intent: 'pi_other', charge: 'ch_other' })));
  assert.equal(res.status, 200);
  assert.equal(state.adjustments.length, 0);
});
