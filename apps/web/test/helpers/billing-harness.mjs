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
 *  replaced by recorders. Returns { provider, calls, subs }. */
export async function loadStripeProvider() {
  setStripeEnv();
  const stripeEntry = new URL(import.meta.resolve('stripe')).href;
  const calls = [];
  const subs = {};
  globalThis.__harness = { calls, subs };
  const wrapper = dataUrl(`
    import Real from ${JSON.stringify(stripeEntry)};
    export default function Stripe(...args) {
      const c = new Real(...args);
      const h = globalThis.__harness;
      c.checkout.sessions.create = async (params, opts) => {
        h.calls.push({ api: 'checkout.sessions.create', params, opts });
        return { id: 'cs_test_' + h.calls.length, url: 'https://checkout.stripe.test/c/pay' };
      };
      c.billingPortal.sessions.create = async (params, opts) => {
        h.calls.push({ api: 'billingPortal.sessions.create', params, opts });
        return { url: 'https://billing.stripe.test/p/session' };
      };
      c.subscriptions.retrieve = async (id) => {
        h.calls.push({ api: 'subscriptions.retrieve', id });
        if (!h.subs[id]) throw new Error('no fixture for ' + id);
        return h.subs[id];
      };
      return c;
    }
  `);
  const js = toJs(readFileSync(join(WEB, 'src/lib/billing/providers/stripe.ts'), 'utf8'))
    .replace(/from ['"]stripe['"]/g, `from '${wrapper}'`);
  const mod = await import(dataUrl(js) + '#' + Math.random());
  mod._resetStripeClientForTests();
  return { provider: new mod.StripeProvider(), calls, subs, mod };
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
export const envelope = (type, object) => ({
  id: `evt_test_${++_evt}`,
  object: 'event',
  api_version: '2026-10-28.endive',
  created: 1_800_000_000,
  livemode: false,
  type,
  data: { object },
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
  };
}

export function fakeDb(state) {
  const query = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ');
    const r = (rows) => ({ rows, rowCount: rows.length });
    if (/pg_advisory_xact_lock/.test(q)) return r([]);
    if (/^SELECT 1 FROM users WHERE id/.test(q)) return r(state.users.filter((u) => u.id === p[0]).map(() => ({})));
    if (/^SELECT email FROM auth\.users/.test(q)) return r([]);
    if (/^SELECT id FROM users WHERE email/.test(q)) return r(state.users.filter((u) => u.email === p[0]).map((u) => ({ id: u.id })));
    if (/^INSERT INTO users/.test(q)) {
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
    if (/^INSERT INTO subscriptions/.test(q)) {
      const [user_id, provider, provider_subscription_id, plan_code, status, ps, pe, cap] = p;
      const row = state.subscriptions.find((s) => s.provider === provider && s.provider_subscription_id === provider_subscription_id);
      const vals = { plan_code, status, current_period_start: ps, current_period_end: pe, cancel_at_period_end: cap };
      if (row) Object.assign(row, vals);
      else state.subscriptions.push({ user_id, provider, provider_subscription_id, ...vals });
      return r([]);
    }
    if (/^UPDATE subscriptions SET status = 'canceled'/.test(q)) {
      const rows = state.subscriptions.filter((s) => s.provider === p[0] && s.provider_subscription_id === p[1]);
      rows.forEach((s) => { s.status = 'canceled'; });
      return r(rows.map((s) => ({ user_id: s.user_id, plan_code: s.plan_code, current_period_end: s.current_period_end })));
    }
    if (/^UPDATE subscriptions SET status = 'past_due'/.test(q)) {
      const rows = state.subscriptions.filter((s) => s.provider === p[0] && s.provider_subscription_id === p[1]);
      rows.forEach((s) => { s.status = 'past_due'; });
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
  return { query, tx: async (fn) => fn({ query }) };
}

/** Load the webhook route wired to the REAL provider and an in-memory DB. */
export async function loadWebhookRoute(provider, state) {
  globalThis.__routeProvider = provider;
  globalThis.__routeDb = fakeDb(state);
  globalThis.__routeState = state;
  const billing = dataUrl(`export const getBillingProvider = () => globalThis.__routeProvider;`);
  // Late-bound: identical data: URLs are cached by Node, so the stub must read
  // the per-test DB from globalThis at call time, not at import time.
  const db = dataUrl(`export const db = {
    query: (...a) => globalThis.__routeDb.query(...a),
    tx: (...a) => globalThis.__routeDb.tx(...a),
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
      if (u) u.welcomed_at = 'now';
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
  const js = toJs(readFileSync(join(WEB, 'src/app/api/billing/webhook/route.ts'), 'utf8'))
    .replace(/from ['"]@\/lib\/billing\/prorata['"]/g, `from '${prorata}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ent}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billing}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/emails\/dispatch['"]/g, `from '${em}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

/** POST a Stripe event through route.POST with a real signature. */
export async function deliver(mod, event) {
  const { body, signature } = sign(event);
  return mod.POST({
    headers: { get: (n) => (n.toLowerCase() === 'stripe-signature' ? signature : null) },
    text: async () => body,
  });
}
