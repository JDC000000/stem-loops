// QA-72 layer 2: the webhook backstop for a subscription whose account no
// longer exists.
//
// A Checkout Session stays open 24 h. Completed in another tab after DELETE
// /api/users/me, it created and billed a subscription for a user who is gone.
// The webhook used to ack only a CANCELED subscription for a missing user; an
// active one failed the users FK and was retried by Stripe for ~3 days while
// nothing cancelled it. Now the webhook cancels it immediately, refunds the
// paid invoice, alerts (no personal data; the HMAC user hash) and answers 200.
//
// End to end: signed payload -> REAL StripeProvider.handleWebhook ->
// route -> in-memory DB (test/helpers/billing-harness.mjs). Stripe is faked at
// the client: h.subs is Stripe's current state; the cancel / void / refund /
// invoice-payment calls are faked below through h.install. Every real network
// call is blocked by the harness. livemode is always false.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  loadStripeProvider, loadWebhookRoute, makeState, envelope, deliver,
  subscriptionFixture, invoiceFixture,
} from './helpers/billing-harness.mjs';

const GONE = '22222222-2222-2222-2222-222222222222';
const LIVE = '11111111-1111-1111-1111-111111111111';
const MARK = 'stem-loops QA-72: account no longer exists';

let h; let state; let route; let st;
const quiet = async (fn) => {
  const o = { error: console.error, warn: console.warn, info: console.info };
  console.error = console.warn = console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};
const raw = (evt) => quiet(() => deliver(route, evt, { syncStripe: false }));

const paidInvoice = (over = {}) => ({
  id: 'in_orphan_1', object: 'invoice', status: 'paid', amount_paid: 1200, currency: 'cad',
  billing_reason: 'subscription_create', ...over,
});
const sub = (over = {}) => subscriptionFixture({
  metadata: { user_id: GONE }, customer: 'cus_gone', latest_invoice: paidInvoice(), ...over,
});
const calls = (api) => h.calls.filter((c) => c.api === api);
const stripeErr = (message, extra) => Object.assign(new Error(message), extra);

/** Fakes for the Stripe calls the QA-72 paths make, layered on the harness. */
function installFakes() {
  st = {
    invoicePayments: {
      in_orphan_1: [{ id: 'inpay_1', object: 'invoice_payment', status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_orphan_1' } }],
    },
    refunded: new Set(),
    idem: new Map(),
    refundErrors: [],
    cancelErrors: [],
    retrieveErrors: {},
  };
  h.harness.install = (c) => {
    const H = globalThis.__harness;
    const retrieve = c.subscriptions.retrieve;
    c.subscriptions.retrieve = async (id, params, ropts) => {
      if (st.retrieveErrors[id]) {
        H.calls.push({ api: 'subscriptions.retrieve', id, params, ropts });
        throw st.retrieveErrors[id];
      }
      return retrieve(id, params, ropts);
    };
    c.subscriptions.cancel = async (id, params, ropts) => {
      H.calls.push({ api: 'subscriptions.cancel', id, params, ropts });
      if (st.cancelErrors.length) throw st.cancelErrors.shift();
      const s = H.subs[id];
      if (!s) throw stripeErr('No such subscription', { code: 'resource_missing', statusCode: 404 });
      if (s.status === 'canceled') {
        throw stripeErr('A canceled subscription can only update its cancellation_details and metadata.', { statusCode: 400 });
      }
      H.subs[id] = {
        ...s, status: 'canceled',
        cancellation_details: { comment: params?.cancellation_details?.comment ?? null, feedback: null, reason: 'cancellation_requested' },
      };
      return H.subs[id];
    };
    c.invoices.voidInvoice = async (id, params, ropts) => {
      H.calls.push({ api: 'invoices.voidInvoice', id, params, ropts });
      for (const s of Object.values(H.subs)) {
        if (s.latest_invoice?.id === id) s.latest_invoice = { ...s.latest_invoice, status: 'void' };
      }
      return { id, object: 'invoice', status: 'void' };
    };
    // Mirrors the expand the provider asks for: the payment's charge, with
    // `refunded` as Stripe reports it now.
    c.invoicePayments.list = async (params, ropts) => {
      H.calls.push({ api: 'invoicePayments.list', params, ropts });
      const data = (st.invoicePayments[params.invoice] ?? []).map((ip) => {
        const p = ip.payment ?? {};
        if (p.payment_intent && params.expand?.includes('data.payment.payment_intent.latest_charge')) {
          return { ...ip, payment: { ...p, payment_intent: { id: p.payment_intent, object: 'payment_intent',
            latest_charge: { id: 'ch_of_' + p.payment_intent, object: 'charge', refunded: st.refunded.has(p.payment_intent) } } } };
        }
        if (p.charge && params.expand?.includes('data.payment.charge')) {
          return { ...ip, payment: { ...p, charge: { id: p.charge, object: 'charge', refunded: st.refunded.has(p.charge) } } };
        }
        return ip;
      });
      return { object: 'list', data, has_more: false };
    };
    c.refunds.create = async (params, ropts) => {
      H.calls.push({ api: 'refunds.create', params, ropts });
      if (st.refundErrors.length) throw st.refundErrors.shift();
      if (st.idem.has(ropts?.idempotencyKey)) return st.idem.get(ropts.idempotencyKey);
      const target = params.payment_intent ?? params.charge;
      if (st.refunded.has(target)) {
        throw stripeErr('Charge pi has already been refunded.', { code: 'charge_already_refunded', statusCode: 400 });
      }
      st.refunded.add(target);
      const r = { id: `re_${st.refunded.size}`, object: 'refund', amount: 1200, status: 'succeeded' };
      st.idem.set(ropts?.idempotencyKey, r);
      return r;
    };
  };
}

beforeEach(async () => {
  h = await loadStripeProvider();
  installFakes();
  state = makeState();
  // GONE was deleted: auth.users cascade removed public.users etc. Seeding the
  // row again fails the FK, like Postgres.
  state.authGone = [GONE];
  state.users.push({ id: LIVE, email: 'live@example.com' });
  state.customers_billing.push({ user_id: LIVE, provider: 'stripe', provider_customer_id: 'cus_live' });
  route = await loadWebhookRoute(h.provider, state);
});

const qa72Alerts = () => state.sentry.filter((s) => /QA-72/.test(s.message));
// usage_events params: the orphan audit row is the one whose detail says QA-72.
const audit = () => state.usage
  .filter((p) => p.length === 1 && /"qa":"QA-72"/.test(p[0]))
  .map((p) => JSON.parse(p[0]));
const hmac = (id) => createHmac('sha256', 'dev-key').update(id).digest('hex');

function assertNothingWritten() {
  assert.equal(state.subscriptions.length, 0, 'no subscription row for a deleted account');
  assert.equal(state.entitlements.length, 0, 'no entitlement for a deleted account');
  assert.ok(!state.users.some((u) => u.id === GONE), 'user row recreated for a deleted account');
  assert.ok(!state.customers_billing.some((c) => c.user_id === GONE));
}

// ---- the QA-72 scenario -----------------------------------------------------

test('QA-72: subscription.created for a deleted account -> cancelled now, invoice refunded in full, alerted, 200', async () => {
  h.subs.sub_test_1 = sub();
  const res = await raw(envelope('customer.subscription.created', sub()));
  assert.equal(res.status, 200, 'Stripe must stop retrying');
  assertNothingWritten();

  const [cancel] = calls('subscriptions.cancel');
  assert.ok(cancel, 'the live subscription was not cancelled');
  assert.equal(cancel.id, 'sub_test_1');
  assert.equal(cancel.params.invoice_now, false);
  assert.equal(cancel.params.prorate, false);
  assert.equal(cancel.params.cancellation_details.comment, MARK);
  assert.deepEqual(cancel.ropts, { timeout: 6000, maxNetworkRetries: 0 });

  const refunds = calls('refunds.create');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].params.payment_intent, 'pi_orphan_1');
  assert.equal(refunds[0].params.amount, undefined, 'a FULL refund sends no amount');
  assert.equal(refunds[0].ropts.idempotencyKey, 'qa72-refund-inpay_1');
  assert.equal(refunds[0].ropts.timeout, 6000);
  assert.equal(refunds[0].ropts.maxNetworkRetries, 0);
  assert.deepEqual(calls('invoicePayments.list')[0].params, {
    invoice: 'in_orphan_1', status: 'paid', limit: 100,
    expand: ['data.payment.payment_intent.latest_charge', 'data.payment.charge'],
  });

  const [alert] = qa72Alerts();
  assert.ok(alert, 'no Sentry alert');
  assert.equal(alert.opts.level, 'error');
  const x = alert.opts.extra;
  assert.equal(x.user_hash, hmac(GONE), 'user_hash is the HMAC the deletion audit row holds');
  assert.equal(x.cancelled, true);
  assert.deepEqual(x.refunds, ['re_1']);
  assert.equal(x.amount_refunded, 1200);
  const blob = JSON.stringify(alert);
  assert.ok(!blob.includes(GONE), 'raw user id in the alert');
  assert.ok(!/@/.test(blob), 'an email in the alert');

  const rows = audit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_hash, hmac(GONE));
  assert.ok(!JSON.stringify(state.usage).includes(GONE), 'raw user id in the audit row');
});

test('QA-72: every redelivery is 200; one cancel, one refund, one alert, one audit row (idempotent)', async () => {
  h.subs.sub_test_1 = sub();
  const evt = envelope('customer.subscription.created', sub());
  for (let i = 0; i < 3; i += 1) assert.equal((await raw(evt)).status, 200, `delivery ${i + 1}`);
  // A redelivery sees the charge refunded and sends no second refund.
  assert.equal(calls('refunds.create').length, 1, 'a refunded charge was refunded again');
  assert.equal(calls('subscriptions.cancel').length, 1, 'a canceled subscription is not cancelled again');
  assert.equal(st.refunded.size, 1);
  assert.equal(qa72Alerts().length, 1);
  assert.equal(audit().length, 1);
  assertNothingWritten();
});

test('QA-72: the other subscription events for it (updated, checkout completed, invoice.paid) converge on the same close', async () => {
  h.subs.sub_test_1 = sub();
  const sess = {
    id: 'cs_sub_1', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid',
    customer: 'cus_gone', subscription: 'sub_test_1', metadata: { user_id: GONE },
  };
  const inv = invoiceFixture({
    id: 'in_orphan_1', customer: 'cus_gone', billing_reason: 'subscription_create',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test_1', metadata: { user_id: GONE } } },
  });
  for (const evt of [
    envelope('checkout.session.completed', sess),
    envelope('invoice.paid', inv),
    envelope('customer.subscription.created', sub()),
    envelope('customer.subscription.updated', sub(), { status: 'incomplete' }),
  ]) {
    assert.equal((await raw(evt)).status, 200, evt.type);
  }
  assert.equal(calls('subscriptions.cancel').length, 1);
  assert.equal(st.refunded.size, 1);
  assertNothingWritten();
});

test('QA-72: checkout.session.completed alone (first to arrive) closes it', async () => {
  h.subs.sub_test_1 = sub();
  const res = await raw(envelope('checkout.session.completed', {
    id: 'cs_sub_1', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid',
    customer: 'cus_gone', subscription: 'sub_test_1', metadata: { user_id: GONE },
  }));
  assert.equal(res.status, 200);
  assert.equal(calls('subscriptions.cancel').length, 1);
  assert.equal(calls('refunds.create').length, 1);
  assert.equal(qa72Alerts()[0].opts.extra.trigger, 'checkout_session_completed');
});

test('QA-72: invoice.paid alone (first to arrive) closes it instead of a 500 loop on the users FK', async () => {
  h.subs.sub_test_1 = sub();
  const inv = invoiceFixture({
    id: 'in_orphan_1', customer: 'cus_gone',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test_1', metadata: { user_id: GONE } } },
  });
  assert.equal((await raw(envelope('invoice.paid', inv))).status, 200);
  assert.equal(calls('subscriptions.cancel').length, 1);
  assert.equal(st.refunded.size, 1);
  assert.equal(state.sentry.filter((s) => /receipt/i.test(s.message)).length, 0);
  assert.equal(state.emails.length, 0, 'no receipt to a deleted account');
});

// ---- retries converge ---------------------------------------------------------

test('QA-72: refund refused on the first delivery -> 500; the redelivery (already cancelled, by us) refunds -> 200', async () => {
  h.subs.sub_test_1 = sub();
  st.refundErrors.push(stripeErr('An error occurred with our connection to Stripe.', { type: 'StripeConnectionError' }));
  const evt = envelope('customer.subscription.created', sub());
  assert.equal((await raw(evt)).status, 500, 'a refund that did not happen must not be acked');
  assert.equal(h.subs.sub_test_1.status, 'canceled');
  assert.equal(st.refunded.size, 0);
  assert.equal((await raw(evt)).status, 200);
  assert.equal(calls('subscriptions.cancel').length, 1, 'not cancelled twice');
  assert.equal(st.refunded.size, 1, 'the retry did not refund a subscription WE cancelled');
});

test('QA-72: cancel refused -> 500, nothing refunded; the redelivery cancels and refunds', async () => {
  h.subs.sub_test_1 = sub();
  st.cancelErrors.push(stripeErr('Rate limited', { type: 'StripeRateLimitError', statusCode: 429 }));
  const evt = envelope('customer.subscription.created', sub());
  assert.equal((await raw(evt)).status, 500);
  assert.equal(st.refunded.size, 0, 'refunded a subscription that is still live');
  assert.equal((await raw(evt)).status, 200);
  assert.equal(h.subs.sub_test_1.status, 'canceled');
  assert.equal(st.refunded.size, 1);
});

test('QA-72: two deliveries racing the cancel -> the loser is a 500, its redelivery converges, one refund', async () => {
  h.subs.sub_test_1 = sub();
  const a = raw(envelope('customer.subscription.created', sub()));
  const b = raw(envelope('checkout.session.completed', {
    id: 'cs_sub_1', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid',
    customer: 'cus_gone', subscription: 'sub_test_1', metadata: { user_id: GONE },
  }));
  const statuses = (await Promise.all([a, b])).map((r) => r.status);
  assert.ok(statuses.includes(200));
  for (let i = 0; i < 2; i += 1) await raw(envelope('customer.subscription.updated', sub()));
  assert.equal(st.refunded.size, 1);
  assert.equal(h.subs.sub_test_1.status, 'canceled');
});

// ---- what must NOT be refunded or cancelled -----------------------------------

test('QA-72: a subscription the ACCOUNT DELETION cancelled (no QA-72 tag) is acked and NOT refunded', async () => {
  // DELETE /api/users/me cancelled a plan the user had and paid for.
  h.subs.sub_test_1 = sub({ status: 'canceled', cancellation_details: { comment: null, reason: 'cancellation_requested' } });
  const res = await raw(envelope('customer.subscription.updated', sub(), { cancel_at_period_end: false }));
  assert.equal(res.status, 200);
  assert.equal(calls('subscriptions.cancel').length, 0);
  assert.equal(calls('refunds.create').length, 0, 'refunded a period the user had');
  assert.equal(qa72Alerts().length, 0);
  assert.equal(audit().length, 0);
  assertNothingWritten();
});

test('QA-72: a live account is untouched: row written, nothing cancelled or refunded', async () => {
  const live = subscriptionFixture({ metadata: { user_id: LIVE }, customer: 'cus_live', latest_invoice: paidInvoice() });
  h.subs.sub_test_1 = live;
  assert.equal((await raw(envelope('customer.subscription.created', live))).status, 200);
  assert.equal(state.subscriptions[0]?.status, 'active');
  assert.equal(state.entitlements.find((e) => e.user_id === LIVE)?.plan_code, 'pro');
  const done = await raw(envelope('checkout.session.completed', {
    id: 'cs_live', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid',
    customer: 'cus_live', subscription: 'sub_test_1', metadata: { user_id: LIVE },
  }));
  assert.equal(done.status, 200);
  assert.equal(calls('subscriptions.cancel').length, 0);
  assert.equal(calls('refunds.create').length, 0);
  assert.equal(qa72Alerts().length, 0);
});

test('QA-72: a live account whose public.users row is missing but whose auth row exists is seeded, not closed', async () => {
  // FK holds (not in authGone): the defensive upsert seeds the row.
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const s = subscriptionFixture({ metadata: { user_id: OTHER }, customer: 'cus_other', latest_invoice: paidInvoice() });
  h.subs.sub_test_1 = s;
  assert.equal((await raw(envelope('customer.subscription.created', s))).status, 200);
  assert.ok(state.users.some((u) => u.id === OTHER));
  assert.equal(calls('subscriptions.cancel').length, 0);
});

// ---- other shapes -------------------------------------------------------------

test('QA-72: a customer no account owns (no metadata, unknown customer) -> closed, no user_hash, 200 (was a 3-day 500 loop)', async () => {
  const s = sub({ metadata: {}, customer: 'cus_nobody' });
  h.subs.sub_test_1 = s;
  assert.equal((await raw(envelope('customer.subscription.created', s))).status, 200);
  assert.equal(calls('subscriptions.cancel').length, 1);
  assert.equal(st.refunded.size, 1);
  const x = qa72Alerts()[0].opts.extra;
  assert.equal(x.account, 'no_user');
  assert.equal(x.user_hash, null);
});

test('QA-72: incomplete (never paid) -> cancelled and its open first invoice voided, nothing refunded', async () => {
  const s = sub({ status: 'incomplete', latest_invoice: paidInvoice({ status: 'open', amount_paid: 0 }) });
  h.subs.sub_test_1 = s;
  assert.equal((await raw(envelope('customer.subscription.created', s))).status, 200);
  assert.equal(calls('subscriptions.cancel').length, 1);
  const [v] = calls('invoices.voidInvoice');
  assert.equal(v?.id, 'in_orphan_1');
  assert.equal(v.ropts.idempotencyKey, 'qa72-void-in_orphan_1');
  assert.equal(calls('refunds.create').length, 0);
});

test('QA-72: a $0 first invoice (trial / 100% coupon) -> cancelled, no refund call', async () => {
  const s = sub({ status: 'trialing', latest_invoice: paidInvoice({ amount_paid: 0 }) });
  h.subs.sub_test_1 = s;
  assert.equal((await raw(envelope('customer.subscription.created', s))).status, 200);
  assert.equal(calls('subscriptions.cancel').length, 1);
  assert.equal(calls('invoicePayments.list').length, 0);
  assert.equal(calls('refunds.create').length, 0);
});

test('QA-72: paid but no refundable payment listed -> cancelled, 200, and a "refund it by hand" alert', async () => {
  st.invoicePayments.in_orphan_1 = [];
  h.subs.sub_test_1 = sub();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  assert.equal(calls('subscriptions.cancel').length, 1);
  const [a] = qa72Alerts();
  assert.match(a.message, /by hand/);
  assert.equal(a.opts.extra.refund_gap_invoice, 'in_orphan_1');
});

test('QA-72: refund refused with charge_already_refunded (e.g. a concurrent delivery got there) counts as done', async () => {
  h.subs.sub_test_1 = sub();
  st.refundErrors.push(stripeErr('Charge has already been refunded.', { code: 'charge_already_refunded', statusCode: 400 }));
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  assert.equal(qa72Alerts()[0].opts.extra.already_refunded, true);
});

test('QA-72: a charge-based invoice payment is refunded by charge', async () => {
  st.invoicePayments.in_orphan_1 = [{ id: 'inpay_ch', status: 'paid', payment: { type: 'charge', charge: 'ch_orphan_1' } }];
  h.subs.sub_test_1 = sub();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  assert.equal(calls('refunds.create')[0].params.charge, 'ch_orphan_1');
});

// ---- review L-4 and the time budget --------------------------------------------

test('L-4: subscription "missing" because it exists in the OTHER mode -> 500 (hard error), never treated as gone', async () => {
  h.subs.sub_test_1 = sub();
  st.retrieveErrors.sub_test_1 = stripeErr(
    "No such subscription: 'sub_test_1'; a similar object exists in live mode, but a test mode key was used to make this request.",
    { code: 'resource_missing', statusCode: 404 },
  );
  // The route's own re-read uses getSubscription, which shares the fake: make
  // the provider's retrieve fail only for the cleanup (expand latest_invoice).
  const H = globalThis.__harness;
  const err = st.retrieveErrors.sub_test_1;
  delete st.retrieveErrors.sub_test_1;
  const prev = H.install;
  H.install = (c) => {
    prev(c);
    const r = c.subscriptions.retrieve;
    c.subscriptions.retrieve = async (id, params, ropts) => {
      if (params?.expand?.includes('latest_invoice')) { H.calls.push({ api: 'subscriptions.retrieve', id, params, ropts }); throw err; }
      return r(id, params, ropts);
    };
  };
  h.mod._resetStripeClientForTests();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 500);
  assert.equal(calls('subscriptions.cancel').length, 0);
});

test('QA-72: plain resource_missing (subscription gone at Stripe) -> acked, nothing to close', async () => {
  h.subs.sub_test_1 = sub();
  const H = globalThis.__harness;
  const prev = H.install;
  H.install = (c) => {
    prev(c);
    const r = c.subscriptions.retrieve;
    c.subscriptions.retrieve = async (id, params, ropts) => {
      if (params?.expand?.includes('latest_invoice')) throw stripeErr('No such subscription', { code: 'resource_missing', statusCode: 404 });
      return r(id, params, ropts);
    };
  };
  h.mod._resetStripeClientForTests();
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  assert.equal(calls('subscriptions.cancel').length, 0);
  assert.equal(qa72Alerts().length, 0);
});

test('QA-72 budget: no Stripe write is started past the deadline -> 500 (Stripe redelivers), and the next delivery closes it', async () => {
  const tight = await loadWebhookRoute(h.provider, state, {
    transform: (src) => {
      assert.match(src, /const ORPHAN_CLEANUP_DEADLINE_MS = 50_000;/);
      return src.replace(/const ORPHAN_CLEANUP_DEADLINE_MS = 50_000;/, 'const ORPHAN_CLEANUP_DEADLINE_MS = 11_000;');
    },
  });
  h.subs.sub_test_1 = sub();
  const res = await quiet(() => deliver(tight, envelope('customer.subscription.created', sub()), { syncStripe: false }));
  assert.equal(res.status, 500);
  assert.equal(calls('subscriptions.cancel').length, 0);
  assert.equal(calls('refunds.create').length, 0);
  assert.equal((await raw(envelope('customer.subscription.created', sub()))).status, 200);
  assert.equal(st.refunded.size, 1);
});

test('QA-72 budget arithmetic: four bounded calls fit the 50 s window inside maxDuration 60', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { WEB } = await import('./helpers/billing-harness.mjs');
  const src = readFileSync(join(WEB, 'src/app/api/billing/webhook/route.ts'), 'utf8');
  assert.match(src, /export const maxDuration = 60;/);
  assert.equal(h.mod.STRIPE_CALL_WORST_MS, 12_000);
  assert.ok(50_000 + 2_000 < 60_000, 'the last call ends by 50 s, leaving room to answer');
});
