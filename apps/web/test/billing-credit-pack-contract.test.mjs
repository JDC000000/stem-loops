// Credit-pack contract through the REAL StripeProvider (issue #141, items 1-2).
//
// Nothing here stubs the BillingProvider or its arguments. Only the Stripe
// network edge is recorded (see helpers/billing-harness.mjs). The properties:
//   * checkout: for EVERY pack, the price sent to Stripe and the pack recorded
//     in metadata are the ones for THAT pack (not a neighbour's).
//   * webhook: a paid session grants the credits for the PRICE that was paid;
//     an unpaid session grants nothing; and when metadata disagrees with the
//     price, the price wins.
// Expected prices are the harness's independent PRICE table, never read back
// out of the provider.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE, loadStripeProvider, loadWebhookRoute, makeState, envelope, deliver, sign,
  creditSessionFixture,
} from './helpers/billing-harness.mjs';

const USER = '11111111-1111-1111-1111-111111111111';
const PACKS = ['credits_20', 'credits_60', 'credits_180'];
// Independent of the code under test: what each pack must be worth.
const CREDITS = { credits_20: 20, credits_60: 60, credits_180: 180 };

let h; let state; let route;
beforeEach(async () => {
  h = await loadStripeProvider();
  state = makeState();
  state.users.push({ id: USER, email: 'payer@example.com' });
  state.customers_billing.push({ user_id: USER, provider: 'stripe', provider_customer_id: 'cus_test_1' });
  route = await loadWebhookRoute(h.provider, state);
});

// ---- checkout: click pack X, be charged for pack X -------------------------

for (const pack of PACKS) {
  test(`checkout ${pack}: Stripe is sent THIS pack's price and metadata.pack_code`, async () => {
    h.calls.length = 0;
    await h.provider.createCreditPurchaseSession(USER, pack, 'https://x/ok', 'https://x/no', null, null, 'cus_test_1');
    assert.equal(h.calls.length, 1);
    const { params } = h.calls[0];
    assert.equal(params.mode, 'payment');
    assert.equal(params.line_items.length, 1);
    assert.equal(params.line_items[0].price, PRICE[pack]);
    assert.equal(params.line_items[0].quantity, 1);
    assert.equal(params.metadata.pack_code, pack);
    assert.equal(params.metadata.price_id, PRICE[pack]);
  });
}

test('checkout: the three packs are sent three DIFFERENT prices', async () => {
  h.calls.length = 0;
  for (const pack of PACKS) {
    await h.provider.createCreditPurchaseSession(USER, pack, 'https://x/ok', 'https://x/no');
  }
  const prices = h.calls.map((c) => c.params.line_items[0].price);
  assert.equal(new Set(prices).size, 3, `prices collapsed: ${prices.join(',')}`);
});

// ---- webhook: the price paid decides what is granted -----------------------

const session = (pack, over = {}) => creditSessionFixture({
  payment_intent: 'pi_' + pack,
  metadata: { user_id: USER, pack_code: pack, price_id: PRICE[pack] },
  ...over,
});

for (const pack of PACKS) {
  test(`webhook ${pack}: real provider derives packCode and the route grants ${CREDITS[pack]} credits`, async () => {
    const { body, signature } = sign(envelope('checkout.session.completed', session(pack)));
    const evt = await h.provider.handleWebhook(body, signature);
    assert.equal(evt.type, 'credit_purchase_completed');
    assert.equal(evt.packCode, pack);

    const res = await deliver(route, envelope('checkout.session.completed', session(pack)));
    assert.equal(res.status, 200);
    assert.equal(state.credit_purchases.length, 1);
    assert.equal(state.credit_purchases[0].pack_code, pack);
    assert.equal(state.credit_purchases[0].credits_granted, CREDITS[pack]);
  });
}

test('webhook: payment_status "unpaid" (async method not yet settled) is unhandled and grants nothing', async () => {
  const evt = envelope('checkout.session.completed', session('credits_180', { payment_status: 'unpaid' }));
  const { body, signature } = sign(evt);
  const parsed = await h.provider.handleWebhook(body, signature);
  assert.equal(parsed.type, 'unhandled');

  const res = await deliver(route, envelope('checkout.session.completed', session('credits_180', { payment_status: 'unpaid' })));
  assert.equal(res.status, 200);
  assert.equal(state.credit_purchases.length, 0, 'credits granted on an unpaid session');
});

test('webhook: async_payment_succeeded grants once the session is paid', async () => {
  const res = await deliver(route, envelope('checkout.session.async_payment_succeeded', session('credits_60')));
  assert.equal(res.status, 200);
  assert.equal(state.credit_purchases[0].credits_granted, 60);
});

for (const [paid, claimed] of [
  ['credits_20', 'credits_180'],
  ['credits_180', 'credits_20'],
  ['credits_60', 'credits_180'],
]) {
  test(`webhook: paid price for ${paid} but metadata.pack_code says ${claimed} -> the PRICE wins`, async () => {
    const s = session(paid, { metadata: { user_id: USER, pack_code: claimed, price_id: PRICE[paid] } });
    const res = await deliver(route, envelope('checkout.session.completed', s));
    assert.equal(res.status, 200);
    assert.equal(state.credit_purchases.length, 1);
    assert.equal(state.credit_purchases[0].pack_code, paid);
    assert.equal(state.credit_purchases[0].credits_granted, CREDITS[paid]);
  });
}

test('webhook: price unknown + metadata.pack_code present -> falls back to metadata (documents current behaviour)', async () => {
  // A price we do not recognise can only be a stale/legacy env; the provider
  // falls back to the pack hint rather than dropping a paid session.
  const s = session('credits_60', { metadata: { user_id: USER, pack_code: 'credits_60', price_id: 'price_unknown' } });
  const { body, signature } = sign(envelope('checkout.session.completed', s));
  const evt = await h.provider.handleWebhook(body, signature);
  assert.equal(evt.type, 'credit_purchase_completed');
  assert.equal(evt.packCode, 'credits_60');
});
