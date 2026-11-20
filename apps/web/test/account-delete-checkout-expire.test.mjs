// QA-72 layer 1: StripeProvider.expireOpenCheckoutSessions, the step account
// deletion runs first so no open Checkout Session of the user can be
// completed (and bill) after the account is gone.
//
// The REAL StripeProvider on the billing harness (test/helpers/billing-harness.mjs):
// the Stripe client's checkout-session calls are faked through h.install, and
// every real network call is blocked. The passthrough tests send calls through
// the REAL stripe-node into the blocked transport to check the request options
// on the wire (one attempt at 6 s; a reset socket is retried exactly once).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStripeProvider } from './helpers/billing-harness.mjs';

let h; let st;
const calls = (api) => h.calls.filter((c) => c.api === api);
const stripeErr = (message, extra) => Object.assign(new Error(message), extra);
const FAR = () => Date.now() + 60_000;

function fakeSessions() {
  st = {
    sessions: {
      cs_a: { id: 'cs_a', object: 'checkout.session', customer: 'cus_1', status: 'open', mode: 'subscription' },
      cs_b: { id: 'cs_b', object: 'checkout.session', customer: 'cus_1', status: 'open', mode: 'payment' },
      cs_done: { id: 'cs_done', object: 'checkout.session', customer: 'cus_1', status: 'complete', mode: 'subscription' },
      cs_other: { id: 'cs_other', object: 'checkout.session', customer: 'cus_2', status: 'open', mode: 'subscription' },
    },
    pages: null,
    listError: null,
    expireErrors: {},
  };
  h.harness.install = (c) => {
    const H = globalThis.__harness;
    c.checkout.sessions.list = async (params, ropts) => {
      H.calls.push({ api: 'checkout.sessions.list', params, ropts });
      if (st.listError) throw st.listError;
      if (st.pages?.length) return st.pages.shift();
      const data = Object.values(st.sessions).filter(
        (s) => s.customer === params.customer && (!params.status || s.status === params.status),
      );
      return { object: 'list', data, has_more: false };
    };
    c.checkout.sessions.expire = async (id, params, ropts) => {
      H.calls.push({ api: 'checkout.sessions.expire', id, params, ropts });
      if (st.expireErrors[id]) throw st.expireErrors[id];
      const s = st.sessions[id];
      if (!s) throw stripeErr('No such checkout.session', { code: 'resource_missing', statusCode: 404 });
      // Stripe: only an `open` session can be expired.
      if (s.status !== 'open') throw stripeErr('This Checkout Session is not open.', { statusCode: 400 });
      s.status = 'expired';
      return s;
    };
  };
}

beforeEach(async () => {
  h = await loadStripeProvider();
  fakeSessions();
});

test('expires every OPEN session of THIS customer, bounded, with a per-session idempotency key', async () => {
  const r = await h.provider.expireOpenCheckoutSessions('cus_1', FAR());
  assert.deepEqual(r.expired.sort(), ['cs_a', 'cs_b'], 'subscription AND credit-pack sessions are both closed');
  const [list] = calls('checkout.sessions.list');
  assert.deepEqual(list.params, { customer: 'cus_1', status: 'open', limit: 100 });
  assert.deepEqual(list.ropts, { timeout: 6000, maxNetworkRetries: 0 });
  const ex = calls('checkout.sessions.expire');
  assert.deepEqual(ex.map((c) => c.id).sort(), ['cs_a', 'cs_b']);
  for (const c of ex) {
    assert.equal(c.ropts.idempotencyKey, `qa72-expire-${c.id}`);
    assert.equal(c.ropts.timeout, 6000);
    assert.equal(c.ropts.maxNetworkRetries, 0);
  }
  assert.equal(st.sessions.cs_other.status, 'open', "another customer's session was touched");
  assert.equal(st.sessions.cs_done.status, 'complete');
});

test('idempotent: a second call finds nothing open and expires nothing', async () => {
  await h.provider.expireOpenCheckoutSessions('cus_1', FAR());
  const r = await h.provider.expireOpenCheckoutSessions('cus_1', FAR());
  assert.deepEqual(r.expired, []);
  assert.equal(calls('checkout.sessions.expire').length, 2);
});

test('pagination: every page is read before expiring', async () => {
  const s = (id) => ({ id, object: 'checkout.session', customer: 'cus_1', status: 'open' });
  st.pages = [
    { object: 'list', data: [s('cs_p1'), s('cs_p2')], has_more: true },
    { object: 'list', data: [s('cs_p3')], has_more: false },
  ];
  for (const id of ['cs_p1', 'cs_p2', 'cs_p3']) st.sessions[id] = s(id);
  const r = await h.provider.expireOpenCheckoutSessions('cus_1', FAR());
  assert.deepEqual(r.expired, ['cs_p1', 'cs_p2', 'cs_p3']);
  assert.equal(calls('checkout.sessions.list')[1].params.starting_after, 'cs_p2');
});

test('an expire refusal throws (the route answers a retryable 502); the retry converges', async () => {
  st.expireErrors.cs_a = stripeErr('Rate limited', { type: 'StripeRateLimitError', statusCode: 429 });
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()), /Rate limited/);
  delete st.expireErrors.cs_a;
  const r = await h.provider.expireOpenCheckoutSessions('cus_1', FAR());
  assert.ok(r.expired.includes('cs_a'));
  assert.equal(st.sessions.cs_a.status, 'expired');
});

test('a session completed between list and expire: refusal throws; the retry no longer lists it', async () => {
  const list = h.harness.install;
  h.harness.install = (c) => {
    list(c);
    const real = c.checkout.sessions.expire;
    c.checkout.sessions.expire = async (id, p, o) => {
      if (id === 'cs_a') st.sessions.cs_a.status = 'complete'; // the user finished it in another tab
      return real(id, p, o);
    };
  };
  h.mod._resetStripeClientForTests();
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()), /not open/);
  const r = await h.provider.expireOpenCheckoutSessions('cus_1', FAR());
  assert.ok(!r.expired.includes('cs_a'));
});

test('a list failure throws (never "nothing open")', async () => {
  st.listError = stripeErr('An error occurred with our connection to Stripe.', { type: 'StripeConnectionError' });
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()), /connection/);
  assert.equal(calls('checkout.sessions.expire').length, 0);
});

test('resource_missing: a customer Stripe does not have has no open sessions; a session already gone is skipped', async () => {
  st.listError = stripeErr('No such customer', { code: 'resource_missing', statusCode: 404 });
  assert.deepEqual(await h.provider.expireOpenCheckoutSessions('cus_x', FAR()), { expired: [] });
  st.listError = null;
  st.expireErrors.cs_a = stripeErr('No such checkout.session', { code: 'resource_missing', statusCode: 404 });
  const r = await h.provider.expireOpenCheckoutSessions('cus_1', FAR());
  assert.deepEqual(r.expired, ['cs_b']);
});

test('L-4: resource_missing because the object exists in the OTHER mode is a hard error, on list and on expire', async () => {
  const other = (m) => stripeErr(`No such customer: 'cus_1'; a similar object exists in ${m} mode, but a ${m === 'live' ? 'test' : 'live'} mode key was used to make this request.`,
    { code: 'resource_missing', statusCode: 404 });
  st.listError = other('live');
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()), /live mode/);
  st.listError = null;
  st.expireErrors.cs_a = other('test');
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()), /test mode/);
  assert.equal(h.mod.isStripeGone(other('live')), false);
  assert.equal(h.mod.isStripeGone(stripeErr('No such customer', { code: 'resource_missing' })), true);
  assert.equal(h.mod.isStripeGone(stripeErr('boom', { statusCode: 500 })), false);
});

test('deadline: no call is started that could end after it (StripeTimeBudgetError, nothing sent)', async () => {
  await assert.rejects(
    h.provider.expireOpenCheckoutSessions('cus_1', Date.now() + 11_000),
    (e) => e.name === 'StripeTimeBudgetError',
  );
  assert.equal(calls('checkout.sessions.list').length, 0);
  // Enough for the list, not for an expire after it.
  const slow = h.harness.install;
  h.harness.install = (c) => {
    slow(c);
    const l = c.checkout.sessions.list;
    c.checkout.sessions.list = async (p, o) => { const r = await l(p, o); await new Promise((res) => setTimeout(res, 60)); return r; };
  };
  h.mod._resetStripeClientForTests();
  await assert.rejects(
    h.provider.expireOpenCheckoutSessions('cus_1', Date.now() + 12_030),
    (e) => e.name === 'StripeTimeBudgetError' && /expire/.test(e.message),
  );
  assert.equal(calls('checkout.sessions.expire').length, 0);
});

test('real stripe-node: list and expire are one attempt at 6 s; a reset socket is retried exactly once', async () => {
  h.harness.install = undefined; // no fakes: the REAL SDK into the blocked transport
  h.mod._resetStripeClientForTests();
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()));
  const a = h.harness.netAttempts;
  assert.equal(a.length, 1);
  assert.equal(a[0].method, 'GET');
  assert.match(a[0].path, /^\/v1\/checkout\/sessions\?/);
  assert.match(a[0].path, /customer=cus_1/);
  assert.match(a[0].path, /status=open/);
  assert.equal(a[0].timeout, 6000);
  h.harness.netAttempts.length = 0;
  h.harness.netErrorCode = 'ECONNRESET';
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()));
  assert.equal(h.harness.netAttempts.length, 2, 'stripe-node retries a reset once even with maxNetworkRetries 0');
  h.harness.netErrorCode = undefined;
});

test('real stripe-node: the expire POST carries its idempotency key on the wire path /expire', async () => {
  const keep = h.harness.install;
  h.harness.install = (c) => {
    const realExpire = c.checkout.sessions.expire.bind(c.checkout.sessions);
    keep(c);
    c.checkout.sessions.expire = (id, p, o) => {
      globalThis.__harness.calls.push({ api: 'checkout.sessions.expire', id, params: p, ropts: o });
      return realExpire(id, p, o);
    };
  };
  h.mod._resetStripeClientForTests();
  h.harness.netAttempts.length = 0;
  await assert.rejects(h.provider.expireOpenCheckoutSessions('cus_1', FAR()));
  const post = h.harness.netAttempts.find((x) => x.method === 'POST');
  assert.ok(post, 'no POST reached the transport');
  assert.match(post.path, /^\/v1\/checkout\/sessions\/cs_[ab]\/expire$/);
  assert.equal(post.timeout, 6000);
});
