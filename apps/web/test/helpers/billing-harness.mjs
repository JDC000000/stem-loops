// Shared harness for the subscription money-path tests.
//
// Unlike the older checkout/webhook tests, nothing here stubs the BillingProvider
// itself. The REAL StripeProvider (lib/billing/providers/stripe.ts) is loaded;
// only the network edge is faked:
//   * `new Stripe()` is wrapped so checkout.sessions.create,
//     billingPortal.sessions.create and subscriptions.retrieve record what the
//     provider actually sends (and return canned data) instead of hitting Stripe.
//   * Webhook payloads are signed with the real stripe signer and parsed by the
//     real `webhooks.constructEvent` inside provider.handleWebhook.
// The webhook route is loaded with the real provider and an in-memory DB.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { SECRET_ENV_URL } from './pure-libs.mjs';

export const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const RealStripe = require('stripe');

export const WEBHOOK_SECRET = 'whsec_test_secret';
export const PRICE = {
  pro: 'price_test_pro',
  studio: 'price_test_studio',
  credits_20: 'price_test_c20',
  credits_60: 'price_test_c60',
  credits_180: 'price_test_c180',
};

const assert = (ok, msg) => { if (!ok) throw new Error('fakeDb: ' + msg); };

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
export const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

export function setStripeEnv() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_harness';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_PRO_MONTHLY = PRICE.pro;
  process.env.STRIPE_PRICE_STUDIO_MONTHLY = PRICE.studio;
  process.env.STRIPE_PRICE_CREDITS_20 = PRICE.credits_20;
  process.env.STRIPE_PRICE_CREDITS_60 = PRICE.credits_60;
  process.env.STRIPE_PRICE_CREDITS_180 = PRICE.credits_180;
}

/** Load the real StripeProvider with the Stripe client's network methods
 *  replaced by recorders. Returns { provider, calls, subs, sessions }.
 *  `subs[id]` is what subscriptions.retrieve returns (Stripe's CURRENT state
 *  of a subscription); `sessions[id]` is what checkout.sessions.retrieve
 *  returns (with line_items). An id with no fixture throws.
 *  No request can leave the process: the client is built with an
 *  httpClient that throws, so any Stripe method NOT faked below fails the
 *  test instead of reaching api.stripe.com. */
export async function loadStripeProvider() {
  setStripeEnv();
  const stripeEntry = new URL(import.meta.resolve('stripe')).href;
  const calls = [];
  const subs = {};
  const sessions = {};
  const invoices = {};
  // retrieveDelays: ms to hold each subscriptions.retrieve, in call order
  // (review M-1 demos). The state is SNAPSHOTTED when the read is issued,
  // like a real slow read: a later change to subs[id] does not reach it.
  globalThis.__harness = { calls, subs, sessions, invoices, retrieveDelays: [], netAttempts: [], passthrough: false };
  const wrapper = dataUrl(`
    import Real from ${JSON.stringify(stripeEntry)};
    const blocked = {
      getClientName: () => 'harness-blocked',
      // A rejected promise (not a sync throw): stripe-node then reports it
      // as a StripeConnectionError through the normal callback path. Each
      // attempt (the SDK's own retries included) is recorded with the
      // timeout the SDK passed, so tests can check the REAL request options.
      makeRequest: (host, port, path, method, headers, body, protocol, timeout) => {
        globalThis.__harness?.netAttempts?.push({ method, path, timeout });
        const err = new Error('harness: real Stripe network call blocked: ' + method + ' ' + host + path);
        // netErrorCode (e.g. 'ECONNRESET') models a reset socket, which
        // stripe-node retries once even with maxNetworkRetries 0.
        if (globalThis.__harness?.netErrorCode) err.code = globalThis.__harness.netErrorCode;
        return Promise.reject(err);
      },
    };
    export default function Stripe(key, opts = {}) {
      // The client keeps the provider's own settings (no harness override of
      // retries or timeouts); only the transport is replaced.
      const c = new Real(key, { ...opts, httpClient: blocked });
      const h = globalThis.__harness;
      // passthrough: send the call through the REAL SDK (into the blocked
      // transport) instead of the fixture, to observe real request options.
      const real = {
        'subscriptions.retrieve': c.subscriptions.retrieve.bind(c.subscriptions),
        'invoices.retrieve': c.invoices.retrieve.bind(c.invoices),
        'checkout.sessions.retrieve': c.checkout.sessions.retrieve.bind(c.checkout.sessions),
        'subscriptions.list': c.subscriptions.list.bind(c.subscriptions),
      };
      // Checkout guard (decision 1A): the customer's subscription list.
      // h.subsList is the page's data (default empty); h.subsListError throws.
      c.subscriptions.list = async (params, ropts) => {
        h.calls.push({ api: 'subscriptions.list', params, ropts });
        if (h.passthrough) return real['subscriptions.list'](params, ropts);
        if (h.subsListError) throw h.subsListError;
        return { object: 'list', data: h.subsList ?? [], has_more: false };
      };
      c.checkout.sessions.retrieve = async (id, params, ropts) => {
        h.calls.push({ api: 'checkout.sessions.retrieve', id, params, ropts });
        if (h.passthrough) return real['checkout.sessions.retrieve'](id, params, ropts);
        if (h.sessionRetrieveError) throw h.sessionRetrieveError;
        if (!h.sessions[id]) throw new Error('no session fixture for ' + id);
        return h.sessions[id];
      };
      c.checkout.sessions.create = async (params, opts) => {
        h.calls.push({ api: 'checkout.sessions.create', params, opts });
        return { id: 'cs_test_' + h.calls.length, url: 'https://checkout.stripe.test/c/pay' };
      };
      c.billingPortal.sessions.create = async (params, opts) => {
        h.calls.push({ api: 'billingPortal.sessions.create', params, opts });
        return { url: 'https://billing.stripe.test/p/session' };
      };
      c.subscriptions.retrieve = async (id, params, ropts) => {
        h.calls.push({ api: 'subscriptions.retrieve', id, params, ropts });
        if (h.passthrough) return real['subscriptions.retrieve'](id, params, ropts);
        const snap = h.subs[id];
        const delay = h.retrieveDelays.length ? h.retrieveDelays.shift() : 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (!snap) throw new Error('no fixture for ' + id);
        return snap;
      };
      c.invoices.retrieve = async (id, params, ropts) => {
        h.calls.push({ api: 'invoices.retrieve', id, params, ropts });
        if (h.passthrough) return real['invoices.retrieve'](id, params, ropts);
        if (!h.invoices[id]) throw new Error('no invoice fixture for ' + id);
        return h.invoices[id];
      };
      // h.install(c), when a test sets it, adds its own fakes last (QA-72's
      // tests fake checkout-session, cancel, refund and invoice-payment calls
      // this way). Methods it does not replace are still the real SDK's,
      // which reach only the blocked transport.
      h.install?.(c);
      return c;
    }
  `);
  const js = toJs(readFileSync(join(WEB, 'src/lib/billing/providers/stripe.ts'), 'utf8'))
    .replace(/from ['"]stripe['"]/g, `from '${wrapper}'`);
  const mod = await import(dataUrl(js) + '#' + Math.random());
  mod._resetStripeClientForTests();
  return { provider: new mod.StripeProvider(), calls, subs, sessions, invoices, mod, harness: globalThis.__harness };
}

/** Sign `event` with the real Stripe signer. Returns { body, signature }. */
export function sign(event) {
  const body = JSON.stringify(event);
  const signature = RealStripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
  });
  return { body, signature };
}

let _evt = 0;
/** A Stripe event. `previous` becomes data.previous_attributes, which a real
 *  customer.subscription.updated carries for the fields that changed; the
 *  route derives R4/R5 from it (PR #272 review B2). */
export const envelope = (type, object, previous) => ({
  id: `evt_test_${++_evt}`,
  object: 'event',
  api_version: '2026-10-28.endive',
  created: 1_800_000_000,
  livemode: false,
  type,
  data: previous ? { object, previous_attributes: previous } : { object },
});

// ---- Stripe object fixtures (shape of a real 2026-10-28 payload) ----------
const PERIOD_START = Math.floor(Date.now() / 1000) - 3600;
const PERIOD_END = PERIOD_START + 30 * 24 * 3600;

export const subscriptionFixture = (over = {}) => ({
  id: 'sub_test_1',
  object: 'subscription',
  customer: 'cus_test_1',
  status: 'active',
  cancel_at_period_end: false,
  created: PERIOD_START,
  metadata: {},
  items: {
    object: 'list',
    data: [
      {
        id: 'si_1',
        object: 'subscription_item',
        price: { id: PRICE.pro, object: 'price' },
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
      },
    ],
  },
  ...over,
});

export const invoiceFixture = (over = {}) => ({
  id: 'in_test_1',
  object: 'invoice',
  customer: 'cus_test_1',
  amount_paid: 1200,
  currency: 'cad',
  hosted_invoice_url: 'https://invoice.stripe.test/i/1',
  status_transitions: { paid_at: PERIOD_START },
  metadata: {},
  parent: {
    type: 'subscription_details',
    subscription_details: { subscription: 'sub_test_1', metadata: {} },
  },
  ...over,
});

export const creditSessionFixture = (over = {}) => ({
  id: 'cs_test_credit',
  object: 'checkout.session',
  mode: 'payment',
  payment_status: 'paid',
  customer: 'cus_test_1',
  customer_email: null,
  customer_details: { email: 'payer@example.com' },
  payment_intent: 'pi_test_1',
  amount_total: 3000,
  currency: 'cad',
  metadata: { user_id: '', pack_code: 'credits_180', price_id: PRICE.credits_180 },
  ...over,
});

/** Register what checkout.sessions.retrieve(id, { expand: ['line_items'] })
 *  returns for `session`: the session plus ONE line item of `priceId`
 *  (default: the price the session's metadata claims, i.e. an honest
 *  session). Pass a different price to model metadata that lies. */
export function stripeSession(h, session, priceId = session.metadata?.price_id, over = {}) {
  h.sessions[session.id] = {
    ...session,
    line_items: {
      object: 'list',
      data: [{ id: 'li_1', object: 'item', quantity: 1, price: { id: priceId, object: 'price' } }],
    },
    ...over,
  };
  return session;
}

export const disputeFixture = (over = {}) => ({
  id: 'du_test_1',
  object: 'dispute',
  charge: 'ch_test_1',
  payment_intent: 'pi_test_1',
  amount: 3000,
  currency: 'cad',
  reason: 'fraudulent',
  ...over,
});

// ---- In-memory DB emulating exactly the statements the money path issues --
export function makeState() {
  return {
    users: [],
    customers_billing: [],
    subscriptions: [],
    entitlements: [],
    credit_purchases: [],
    adjustments: [],
    usage: [],
    promo: [],
    invalidated: [],
    // Every email dispatcher call the route makes: { fn, userId, vars }.
    emails: [],
    // Every Sentry capture the route makes: { kind, message, opts }.
    sentry: [],
    // Advisory-lock keys taken, in order (fakeDb.tx serialises on them).
    lockLog: [],
    // Fault injection: [{ re, times }]. A statement matching `re` throws
    // (after any earlier statements in the handler took effect) `times`
    // times, to model a partial failure that Stripe then retries.
    failures: [],
  };
}

export function fakeDb(state) {
  const query = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ');
    const r = (rows) => ({ rows, rowCount: rows.length });
    const f = (state.failures ?? []).find((x) => x.times > 0 && x.re.test(q));
    if (f) { f.times -= 1; throw new Error('fakeDb: injected failure: ' + q.slice(0, 60)); }
    if (/pg_advisory_xact_lock/.test(q)) return r([]); // only reached outside fakeDb.tx
    if (/^SET LOCAL /.test(q) || /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.test(q)) return r([]);
    if (/^SELECT set_config\('lock_timeout'/.test(q)) return r([{}]);
    if (/^SELECT welcomed_at FROM users WHERE id = \$1/.test(q))
      return r(state.users.filter((u) => u.id === p[0]).map((u) => ({ welcomed_at: u.welcomed_at ? new Date(u.welcomed_at) : null })));
    if (/^SELECT 1 FROM users WHERE id/.test(q)) return r(state.users.filter((u) => u.id === p[0]).map(() => ({})));
    if (/^SELECT email FROM auth\.users/.test(q)) return r([]);
    if (/^SELECT id FROM users WHERE email/.test(q)) return r(state.users.filter((u) => u.email === p[0]).map((u) => ({ id: u.id })));
    if (/^INSERT INTO users/.test(q)) {
      // public.users.id REFERENCES auth.users: an id in state.authGone (an
      // account deleted through auth.admin.deleteUser) fails like Postgres.
      if ((state.authGone ?? []).includes(p[0]) && !state.users.some((u) => u.id === p[0]))
        throw Object.assign(new Error('insert or update on table "users" violates foreign key constraint'), { code: '23503' });
      if (!state.users.some((u) => u.id === p[0])) state.users.push({ id: p[0], email: p[1] });
      return r([]);
    }
    if (/^SELECT user_id FROM customers_billing WHERE provider = \$1 AND provider_customer_id/.test(q))
      return r(state.customers_billing.filter((c) => c.provider === p[0] && c.provider_customer_id === p[1]).map((c) => ({ user_id: c.user_id })));
    if (/^INSERT INTO customers_billing/.test(q)) {
      if (!state.customers_billing.some((c) => c.user_id === p[0] && c.provider === p[1]))
        state.customers_billing.push({ user_id: p[0], provider: p[1], provider_customer_id: p[2] });
      return r([]);
    }
    if (/^SELECT status, plan_code, cancel_at_period_end FROM subscriptions WHERE provider = \$1 AND provider_subscription_id = \$2/.test(q))
      return r(state.subscriptions
        .filter((s) => s.provider === p[0] && s.provider_subscription_id === p[1])
        .map((s) => ({ status: s.status, plan_code: s.plan_code, cancel_at_period_end: s.cancel_at_period_end })));
    if (/^SELECT 1 FROM subscriptions WHERE user_id = \$1 AND status IN \('active','trialing','past_due'\) LIMIT 1/.test(q))
      return r(state.subscriptions.filter((s) => s.user_id === p[0] && ['active', 'trialing', 'past_due'].includes(s.status)).slice(0, 1).map(() => ({})));
    if (/^SELECT user_id FROM subscriptions WHERE provider = \$1 AND provider_subscription_id/.test(q))
      return r(state.subscriptions.filter((s) => s.provider === p[0] && s.provider_subscription_id === p[1]).map((s) => ({ user_id: s.user_id })));
    if (/^INSERT INTO subscriptions/.test(q) && /SELECT \$1::uuid, .*'canceled'.* WHERE EXISTS \(SELECT 1 FROM users WHERE id = \$1::uuid\)/.test(q)) {
      // subscription_canceled's TOMBSTONE (review M-1 demo 2): written only
      // while the user row still exists (review R2-1).
      const [user_id, provider, provider_subscription_id, plan_code, ps, pe] = p;
      if (!state.users.some((u) => u.id === user_id)) return { rows: [], rowCount: 0 };
      const row = state.subscriptions.find((s) => s.provider === provider && s.provider_subscription_id === provider_subscription_id);
      if (row) Object.assign(row, { status: 'canceled', cancel_at_period_end: true });
      else state.subscriptions.push({ user_id, provider, provider_subscription_id, plan_code, status: 'canceled',
        current_period_start: ps, current_period_end: pe, cancel_at_period_end: true });
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO subscriptions/.test(q)) {
      const [user_id, provider, provider_subscription_id, plan_code, status, ps, pe, cap] = p;
      const row = state.subscriptions.find((s) => s.provider === provider && s.provider_subscription_id === provider_subscription_id);
      const vals = { plan_code, status, current_period_start: ps, current_period_end: pe, cancel_at_period_end: cap };
      // Mirrors `ON CONFLICT ... DO UPDATE ... WHERE subscriptions.status <>
      // 'canceled' RETURNING status` (QA B-04): a skipped update returns no row.
      const guarded = /WHERE subscriptions\.status <> 'canceled'/.test(q);
      if (row) {
        if (guarded && row.status === 'canceled') return r([]);
        Object.assign(row, vals);
      } else state.subscriptions.push({ user_id, provider, provider_subscription_id, ...vals });
      return r([{ status }]);
    }
    if (/^UPDATE subscriptions SET status = 'canceled'/.test(q)) {
      const rows = state.subscriptions.filter((s) => s.provider === p[0] && s.provider_subscription_id === p[1]);
      rows.forEach((s) => { s.status = 'canceled'; });
      return r(rows.map((s) => ({ user_id: s.user_id, plan_code: s.plan_code, current_period_end: s.current_period_end })));
    }
    if (/^UPDATE subscriptions SET status = \$3, updated_at = now\(\)/.test(q)) {
      // invoice_payment_failed applies Stripe's CURRENT status (QA B-04).
      // Mirrors `AND status NOT IN ('incomplete', 'canceled')` (review B1).
      assert(/AND status NOT IN \('incomplete', 'canceled'\)/.test(q), 'payment_failed UPDATE must skip incomplete/canceled');
      const rows = state.subscriptions.filter((s) => s.provider === p[0] && s.provider_subscription_id === p[1]
        && !['incomplete', 'canceled'].includes(s.status));
      rows.forEach((s) => { s.status = p[2]; });
      return r(rows.map((s) => ({ user_id: s.user_id, plan_code: s.plan_code, current_period_start: s.current_period_start })));
    }
    if (/^INSERT INTO entitlements/.test(q)) {
      const [user_id, plan_code, period_start, period_end] = p;
      const row = state.entitlements.find((e) => e.user_id === user_id);
      if (row) Object.assign(row, { plan_code, period_start, period_end });
      else state.entitlements.push({ user_id, plan_code, period_start, period_end, jobs_used: 0 });
      return r([]);
    }
    if (/^UPDATE entitlements SET plan_code = 'free'/.test(q)) {
      const live = state.subscriptions.some((s) => s.user_id === p[0] && ['active', 'trialing', 'past_due'].includes(s.status));
      if (!live) state.entitlements.filter((e) => e.user_id === p[0] && e.plan_code !== 'free').forEach((e) => { e.plan_code = 'free'; });
      return r([]);
    }
    if (/^INSERT INTO credit_purchases/.test(q)) {
      const [user_id, provider, provider_charge_id, pack_code, credits_granted, amount_cad_cents] = p;
      if (!state.credit_purchases.some((c) => c.provider === provider && c.provider_charge_id === provider_charge_id))
        state.credit_purchases.push({ user_id, provider, provider_charge_id, pack_code, credits_granted, amount_cad_cents });
      return r([]);
    }
    if (/^INSERT INTO promo_redemptions/.test(q)) { state.promo.push(p); return r([]); }
    if (/FROM credit_purchases WHERE provider/.test(q)) {
      const rows = state.credit_purchases.filter((c) => c.provider === p[0] && p[1].includes(c.provider_charge_id));
      return r(rows.slice(0, 1));
    }
    if (/FROM credit_adjustments/.test(q)) {
      const sum = state.adjustments
        .filter((a) => a.reason === 'refund' && a.provider === p[0] && a.provider_charge_id === p[1])
        .reduce((n, a) => n - a.credits_delta, 0);
      return r([{ clawed: sum }]);
    }
    if (/^INSERT INTO credit_adjustments/.test(q)) {
      const [user_id, credits_delta, provider, provider_event_id, provider_charge_id] = p;
      if (state.adjustments.some((a) => a.provider === provider && a.provider_event_id === provider_event_id))
        return { rows: [], rowCount: 0 };
      state.adjustments.push({ user_id, credits_delta, reason: 'refund', provider, provider_event_id, provider_charge_id });
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO usage_events/.test(q)) { state.usage.push(p); return r([]); }
    throw new Error('fakeDb: unexpected SQL: ' + q);
  };
  // A transaction that SERIALISES on pg_advisory_xact_lock keys, like
  // Postgres: a second tx asking for a held key waits until the holder's tx
  // ends. Without this the M-1 race tests could not fail or pass honestly.
  const locks = (state.__locks ??= new Map());
  const acquire = async (key) => {
    while (locks.has(key)) await locks.get(key).done;
    let release;
    const done = new Promise((res) => { release = res; });
    locks.set(key, { done, release });
  };
  const releaseKey = (key) => { const l = locks.get(key); locks.delete(key); l?.release(); };
  // Like Postgres, a statement that fails inside a transaction ABORTS it:
  // every later statement fails until ROLLBACK TO SAVEPOINT (this is what the
  // ensureUserRow savepoint exists for).
  const tx = async (fn) => {
    const held = [];
    let aborted = false;
    const client = {
      query: async (sql, p = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        if (/^ROLLBACK TO SAVEPOINT /.test(flat)) { aborted = false; return { rows: [], rowCount: 0 }; }
        if (aborted) throw new Error('fakeDb: current transaction is aborted, commands ignored until end of transaction block');
        try {
          return await txQuery(sql, p);
        } catch (err) {
          aborted = true;
          throw err;
        }
      },
    };
    const txQuery = async (sql, p) => {
        if (/^SELECT set_config\('lock_timeout'/.test(sql.trim())) state.lockLog?.push({ sql: sql.replace(/\s+/g, ' '), key: null, params: p });
        if (/pg_advisory_xact_lock/.test(sql)) {
          const key = p.join('|');
          state.lockLog?.push({ sql: sql.replace(/\s+/g, ' '), key });
          await acquire(key);
          held.push(key);
          return { rows: [], rowCount: 0 };
        }
        return query(sql, p);
    };
    try { return await fn(client); } finally { held.forEach(releaseKey); }
  };
  return { query, tx };
}

/** A recording @sentry/nextjs stub; captures land in globalThis.__routeState.sentry. */
export function sentryStubUrl() {
  return dataUrl(`
    const rec = (kind) => (message, opts) => { globalThis.__routeState?.sentry?.push({ kind, message, opts }); };
    export const captureMessage = rec('message');
    export const captureException = rec('exception');
  `);
}

/** Load the webhook route wired to the REAL provider and an in-memory DB.
 *  `transform` (tests only) may rewrite the route source first, e.g. to
 *  shorten a timeout so a real-PG test can trip it in seconds. */
export async function loadWebhookRoute(provider, state, { transform } = {}) {
  globalThis.__routeProvider = provider;
  globalThis.__routeDb = fakeDb(state);
  globalThis.__routeSharedDb = undefined;
  globalThis.__routeState = state;
  const billing = dataUrl(`export const getBillingProvider = () => globalThis.__routeProvider;`);
  // Late-bound: identical data: URLs are cached by Node, so the stub must read
  // the per-test DB from globalThis at call time, not at import time.
  // webhookDb = the webhook's own pool (what the route must use); db = the
  // shared pool (__routeSharedDb when a test sets one apart, review R2-2).
  const db = dataUrl(`
    export const webhookDb = {
      query: (...a) => globalThis.__routeDb.query(...a),
      tx: (...a) => globalThis.__routeDb.tx(...a),
    };
    const shared = () => globalThis.__routeSharedDb ?? globalThis.__routeDb;
    export const db = {
      query: (...a) => shared().query(...a),
      tx: (...a) => shared().tx(...a),
    };`);
  const ent = dataUrl(`export const invalidateEntitlement = (u) => { globalThis.__routeState.invalidated.push(u); };`);
  // Recording email stubs. sendWelcomeIfFirstTime mirrors the real
  // welcomed_at guard (per user, once) and returns whether it "sent".
  const em = dataUrl(`
    const rec = (fn) => async (userId, vars) => {
      globalThis.__routeState.emails?.push({ fn, userId, vars });
    };
    export const sendWelcomeIfFirstTime = async (userId, vars) => {
      const st = globalThis.__routeState;
      const u = st.users.find((x) => x.id === userId);
      if (u?.welcomed_at) return false;
      if (u) u.welcomed_at = new Date().toISOString();
      st.emails?.push({ fn: 'sendWelcomeIfFirstTime', userId, vars });
      return true;
    };
    export const sendSubscriptionChanged = rec('sendSubscriptionChanged');
    export const sendPlanEnding = rec('sendPlanEnding');
    export const sendPlanEnded = rec('sendPlanEnded');
    export const sendPaymentFailed = rec('sendPaymentFailed');
    export const sendReceipt = rec('sendReceipt');
  `);
  const next = dataUrl(`
    export class NextResponse {
      static json(body, init = {}) { return { status: init.status ?? 200, body }; }
    }
  `);
  const prorata = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/billing/prorata.ts'), 'utf8')));
  let routeSrc = readFileSync(join(WEB, 'src/app/api/billing/webhook/route.ts'), 'utf8');
  if (transform) routeSrc = transform(routeSrc);
  const js = toJs(routeSrc)
    .replace(/from ['"]@\/lib\/billing\/prorata['"]/g, `from '${prorata}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ent}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billing}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/emails\/dispatch['"]/g, `from '${em}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStubUrl()}'`)
    // QA-72: the route keys its alert user_hash with IP_HASH_KEY.
    .replace(/from ['"]@\/lib\/secret-env['"]/g, `from '${SECRET_ENV_URL}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

/** POST a Stripe event through route.POST with a real signature.
 *
 *  The route re-reads a subscription from Stripe on every
 *  customer.subscription.* event (QA B-04). By default `deliver` models
 *  IN-ORDER delivery: Stripe's current state of the subscription is the
 *  object the event carries, so `subs[id]` is set to it before the POST.
 *  Pass { syncStripe: false } to leave `subs` alone and model a stale,
 *  replayed or out-of-order delivery against the state a test set. */
export async function deliver(mod, event, { syncStripe = true } = {}) {
  const obj = event?.data?.object;
  if (syncStripe && /^customer\.subscription\./.test(event?.type ?? '') && obj?.id && globalThis.__harness?.subs) {
    globalThis.__harness.subs[obj.id] = obj;
  }
  const { body, signature } = sign(event);
  return mod.POST({
    headers: { get: (n) => (n.toLowerCase() === 'stripe-signature' ? signature : null) },
    text: async () => body,
  });
}
