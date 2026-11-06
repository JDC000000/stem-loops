// Real StripeProvider, stubbed Stripe client: assert what the provider actually
// SENDS to checkout.sessions.create / billingPortal.sessions.create, and what
// the real handleWebhook parser extracts from signed Stripe payloads.
//
// Why this exists: checkout-hcaptcha-gate / checkout-promo-id-resolution stub
// createCreditPurchaseSession and ignore its arguments, so the provider was
// never exercised and three subscription-fulfilment bugs shipped.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE, loadStripeProvider, sign, envelope,
  subscriptionFixture, invoiceFixture, creditSessionFixture, disputeFixture,
} from './helpers/billing-harness.mjs';

const USER = '11111111-1111-1111-1111-111111111111';
let provider; let calls;

before(async () => {
  ({ provider, calls } = await loadStripeProvider());
});
const last = () => calls[calls.length - 1];

test('subscription checkout: sends user_id on subscription_data.metadata (not only session metadata)', async () => {
  calls.length = 0;
  await provider.createCheckoutSession(USER, 'pro', 'https://x/ok', 'https://x/no', null, null, 'cus_stored');
  const { api, params } = last();
  assert.equal(api, 'checkout.sessions.create');
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [{ price: PRICE.pro, quantity: 1 }]);
  assert.equal(params.metadata.user_id, USER);
  assert.deepEqual(params.subscription_data?.metadata, { user_id: USER, plan_code: 'pro' });
});

test('subscription checkout: attaches the STORED customer', async () => {
  calls.length = 0;
  await provider.createCheckoutSession(USER, 'studio', 'https://x/ok', 'https://x/no', null, null, 'cus_stored');
  assert.equal(last().params.customer, 'cus_stored');
  assert.deepEqual(last().params.line_items, [{ price: PRICE.studio, quantity: 1 }]);
});

test('credit-pack checkout: mode payment, correct price, STORED customer', async () => {
  calls.length = 0;
  await provider.createCreditPurchaseSession(USER, 'credits_60', 'https://x/ok', 'https://x/no', 'SAVE5', 'promo_1', 'cus_stored');
  const { params } = last();
  assert.equal(params.mode, 'payment');
  assert.deepEqual(params.line_items, [{ price: PRICE.credits_60, quantity: 1 }]);
  assert.equal(params.customer, 'cus_stored');
  assert.equal(params.metadata.user_id, USER);
  assert.equal(params.metadata.promo_code, 'SAVE5');
  assert.equal(params.metadata.stripe_promotion_code_id, 'promo_1');
});

test('no customerId given: no customer key is invented (and a warning is logged)', async () => {
  calls.length = 0;
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await provider.createCheckoutSession(USER, 'pro', 'https://x/ok', 'https://x/no');
  } finally {
    console.warn = orig;
  }
  assert.equal('customer' in last().params, false);
  assert.ok(warns.some((w) => /without customerId/.test(w)), 'missing customer must be visible in logs');
});

test('portal session opens the customer it is given', async () => {
  calls.length = 0;
  const res = await provider.createPortalSession('cus_stored', 'https://x/account');
  assert.equal(last().api, 'billingPortal.sessions.create');
  assert.equal(last().params.customer, 'cus_stored');
  assert.equal(res.url, 'https://billing.stripe.test/p/session');
});

// ---- webhook parsing through the REAL constructEvent -----------------------

const parse = (event) => {
  const { body, signature } = sign(event);
  return provider.handleWebhook(body, signature);
};

test('handleWebhook rejects a tampered payload (real signature check)', async () => {
  const { body, signature } = sign(envelope('customer.subscription.created', subscriptionFixture()));
  await assert.rejects(() => provider.handleWebhook(body + ' ', signature));
});

test('customer.subscription.created: user_id from subscription metadata, plan from price', async () => {
  const evt = await parse(envelope('customer.subscription.created',
    subscriptionFixture({ metadata: { user_id: USER, plan_code: 'pro' } })));
  assert.equal(evt.type, 'subscription_upserted');
  assert.equal(evt.userId, USER);
  assert.equal(evt.subscription.planCode, 'pro');
  assert.equal(evt.subscription.providerCustomerId, 'cus_test_1');
  assert.equal(evt.subscription.status, 'active');
});

test('customer.subscription.created with EMPTY metadata surfaces userId "" and the customer id', async () => {
  const evt = await parse(envelope('customer.subscription.created', subscriptionFixture()));
  assert.equal(evt.type, 'subscription_upserted');
  assert.equal(evt.userId, '');
  assert.equal(evt.subscription.providerCustomerId, 'cus_test_1');
});

test('customer.subscription.deleted carries the customer id for fallback resolution', async () => {
  const evt = await parse(envelope('customer.subscription.deleted', subscriptionFixture()));
  assert.equal(evt.type, 'subscription_canceled');
  assert.equal(evt.providerCustomerId, 'cus_test_1');
});

test('invoice.paid: customer id, subscription id, and user_id from parent.subscription_details.metadata', async () => {
  const evt = await parse(envelope('invoice.paid', invoiceFixture({
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test_1', metadata: { user_id: USER } } },
  })));
  assert.equal(evt.type, 'invoice_paid');
  assert.equal(evt.providerSubscriptionId, 'sub_test_1');
  assert.equal(evt.providerCustomerId, 'cus_test_1');
  assert.equal(evt.userId, USER);
  assert.equal(evt.invoice.amountCents, 1200);
});

test('invoice.paid with no metadata anywhere: userId "" + customer id (route resolves)', async () => {
  const evt = await parse(envelope('invoice.paid', invoiceFixture()));
  assert.equal(evt.userId, '');
  assert.equal(evt.providerCustomerId, 'cus_test_1');
});

test('checkout.session.completed (payment): pack from price, customer id carried even when metadata.user_id is empty', async () => {
  const evt = await parse(envelope('checkout.session.completed', creditSessionFixture()));
  assert.equal(evt.type, 'credit_purchase_completed');
  assert.equal(evt.userId, '');
  assert.equal(evt.packCode, 'credits_180');
  assert.equal(evt.providerCustomerId, 'cus_test_1');
  assert.equal(evt.providerChargeId, 'pi_test_1');
  assert.equal(evt.customerEmail, 'payer@example.com');
});

test('charge.dispute.created: event id + charge + payment_intent carried', async () => {
  const env = envelope('charge.dispute.created', disputeFixture());
  const evt = await parse(env);
  assert.equal(evt.type, 'dispute_created');
  assert.equal(evt.providerEventId, env.id);
  assert.equal(evt.providerChargeId, 'ch_test_1');
  assert.equal(evt.providerPaymentIntentId, 'pi_test_1');
});
