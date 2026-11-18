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
  creditSessionFixture, stripeSession,
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

// An honest session: the line item Stripe returns on retrieve is the price
// the metadata claims (register a different one to model lying metadata).
const session = (pack, over = {}) => stripeSession(h, creditSessionFixture({
  payment_intent: 'pi_' + pack,
  metadata: { user_id: USER, pack_code: pack, price_id: PRICE[pack] },
  ...over,
}));

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

// QA B-15: the pack comes from the session's LINE ITEM (what Stripe sold),
// never from session.metadata. Each case pays for `paid` while BOTH
// metadata.pack_code and metadata.price_id claim `claimed`.
for (const [paid, claimed] of [
  ['credits_20', 'credits_180'],
  ['credits_180', 'credits_20'],
  ['credits_60', 'credits_180'],
]) {
  test(`webhook: line item is ${paid}, metadata (price_id AND pack_code) says ${claimed} -> the LINE ITEM wins`, async () => {
    const s = creditSessionFixture({
      payment_intent: 'pi_' + paid,
      metadata: { user_id: USER, pack_code: claimed, price_id: PRICE[claimed] },
    });
    stripeSession(h, s, PRICE[paid]);
    const o = console.warn; const warns = [];
    console.warn = (...a) => warns.push(a.join(' '));
    let res;
    try { res = await deliver(route, envelope('checkout.session.completed', s)); } finally { console.warn = o; }
    assert.equal(res.status, 200);
    assert.equal(state.credit_purchases.length, 1);
    assert.equal(state.credit_purchases[0].pack_code, paid);
    assert.equal(state.credit_purchases[0].credits_granted, CREDITS[paid]);
    assert.ok(warns.some((w) => /disagrees with the line item/.test(w)), 'the mismatch is logged');
    const r = h.calls.find((c) => c.api === 'checkout.sessions.retrieve');
    assert.deepEqual(r?.params, { expand: ['line_items'] }, 'line items are expanded on retrieve');
  });
}

test('webhook: line-item price unknown -> nothing granted, even with a valid metadata.pack_code', async () => {
  const s = creditSessionFixture({
    payment_intent: 'pi_unknown',
    metadata: { user_id: USER, pack_code: 'credits_180', price_id: PRICE.credits_180 },
  });
  stripeSession(h, s, 'price_unknown');
  const o = console.error; console.error = () => {};
  let res;
  try { res = await deliver(route, envelope('checkout.session.completed', s)); } finally { console.error = o; }
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'unhandled');
  assert.equal(state.credit_purchases.length, 0, 'metadata.pack_code must not be a fallback');
  // Review L-5: money taken, nothing granted -> a Sentry ERROR, not just a log.
  assert.equal(state.sentry.length, 1);
  assert.equal(state.sentry[0].opts.level, 'error');
  assert.match(state.sentry[0].message, /Paid credit session cs_test_credit NOT granted/);
  assert.equal(state.sentry[0].opts.extra.payment_intent, 'pi_unknown');
});

test('webhook: more than one line item, or quantity != 1 -> nothing granted', async () => {
  for (const [i, over] of [
    { line_items: { object: 'list', data: [
      { id: 'li_1', quantity: 1, price: { id: PRICE.credits_20 } },
      { id: 'li_2', quantity: 1, price: { id: PRICE.credits_180 } },
    ] } },
    { line_items: { object: 'list', data: [{ id: 'li_1', quantity: 9, price: { id: PRICE.credits_20 } }] } },
  ].entries()) {
    const s = creditSessionFixture({ id: 'cs_multi_' + i, payment_intent: 'pi_multi_' + i });
    stripeSession(h, s, PRICE.credits_20, over);
    const o = console.error; console.error = () => {};
    let res;
    try { res = await deliver(route, envelope('checkout.session.completed', s)); } finally { console.error = o; }
    assert.equal(res.status, 200);
  }
  assert.equal(state.credit_purchases.length, 0);
  assert.equal(state.sentry.length, 2, 'each paid-but-not-granted session raises a Sentry error');
  assert.ok(state.sentry.every((c) => c.opts.level === 'error' && /NOT granted/.test(c.message)));
});

test('webhook: line-item read fails -> 500 so Stripe retries, nothing granted; the retry grants once', async () => {
  const s = session('credits_60');
  h.harness.sessionRetrieveError = new Error('stripe api 503');
  const o = console.error; console.error = () => {};
  let res;
  try { res = await deliver(route, envelope('checkout.session.completed', s)); } finally { console.error = o; }
  assert.equal(res.status, 500, 'a 400 would tell Stripe never to retry a paid purchase');
  assert.equal(state.credit_purchases.length, 0);
  h.harness.sessionRetrieveError = null;
  const evt = envelope('checkout.session.completed', s);
  assert.equal((await deliver(route, evt)).status, 200);
  assert.equal((await deliver(route, evt)).status, 200, 'replay');
  assert.equal(state.credit_purchases.length, 1, 'per-payment dedupe still holds');
  assert.equal(state.credit_purchases[0].credits_granted, 60);
});
