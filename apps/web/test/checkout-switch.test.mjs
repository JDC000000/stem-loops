// B-8w "P" (Jon, 2026-11-25: "P hide checkout during beta"). Stripe stays in sandbox until
// January, so checkout is OFF unless BILLING_CHECKOUT_ENABLED is exactly 'true'
// (src/lib/billing/checkout-switch.ts). Pinned here:
//   1. env parsing: only 'true' enables; unset, '', 'TRUE', '1', 'yes', ' true' do not;
//   2. planCta: no purchase kind ('checkout' / 'sign-in') when off; unchanged when on;
//   3. POST /api/billing/checkout: 403 CHECKOUT_DISABLED when off, before auth, the body, the
//      DB and the billing provider; the enabled path still creates a session;
//   4. /pricing rendered with the REAL BillingButton/pricing-copy/switch: when off, prices
//      stay, no checkout control, no "Get <plan>" / "Buy credits" link, no hCaptcha, no lime;
//   5. the purchase entry-point inventory: BillingButton-to-checkout, PackBuyButton and
//      CreditPackCheckout are rendered by app/pricing/page.tsx only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { wirePureLibs } from './helpers/pure-libs.mjs';
import { renderPricingPage, pricingPageTree, limeFills } from './helpers/render-pricing-page.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const sw = await import(dataUrl(toJs(read('src/lib/billing/checkout-switch.ts'))));
const { planCta } = await import(dataUrl(toJs(read('src/lib/pricing-copy.ts'))));
const { ERROR_COPY } = await import(dataUrl(toJs(read('src/lib/error-copy.ts'))));

const ENV = 'BILLING_CHECKOUT_ENABLED';
let saved;
beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; globalThis.__calls = []; });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

// ── 1. env parsing ────────────────────────────────────────────────────────────
test('switch: the env name and the typed code are pinned', () => {
  assert.equal(sw.CHECKOUT_ENV, 'BILLING_CHECKOUT_ENABLED');
  assert.equal(sw.CHECKOUT_DISABLED, 'CHECKOUT_DISABLED');
});

test('switch: only the exact string "true" enables checkout', () => {
  assert.equal(sw.checkoutEnabledFromEnv('true'), true);
  for (const v of [undefined, null, '', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'false', '0']) {
    assert.equal(sw.checkoutEnabledFromEnv(v), false, `${JSON.stringify(v)} must not enable checkout`);
  }
});

test('switch: unset is OFF (fail closed); isCheckoutEnabled reads the env per call', () => {
  assert.equal(sw.isCheckoutEnabled(), false, 'unset env must mean OFF');
  process.env[ENV] = 'true';
  assert.equal(sw.isCheckoutEnabled(), true);
  process.env[ENV] = '1';
  assert.equal(sw.isCheckoutEnabled(), false);
  assert.equal(sw.isCheckoutEnabled({}), false);
  assert.equal(sw.isCheckoutEnabled({ BILLING_CHECKOUT_ENABLED: 'true' }), true);
});

// ── 2. planCta ───────────────────────────────────────────────────────────────
test('planCta OFF: no card offers a purchase; non-purchase kinds are unchanged', () => {
  for (const off of [false, undefined]) {
    assert.deepEqual(planCta('pro', true, 'free', 'pro', off), { kind: 'unavailable' });
    assert.deepEqual(planCta('studio', true, 'free', 'pro', off), { kind: 'unavailable' });
    assert.deepEqual(planCta('pro', false, null, 'pro', off), { kind: 'unavailable' }, 'signed out: no "Get Pro" sign-in link');
    assert.deepEqual(planCta('studio', false, null, 'pro', off), { kind: 'unavailable' });
    assert.deepEqual(planCta('free', false, null, 'pro', off), { kind: 'start-free' });
    assert.deepEqual(planCta('free', true, 'free', 'pro', off), { kind: 'current' });
    assert.deepEqual(planCta('studio', true, 'pro', null, off), { kind: 'change' });
    assert.deepEqual(planCta('free', true, 'pro', null, off), { kind: 'manage' });
    assert.deepEqual(planCta('pro', true, null, null, off), { kind: 'manage' });
  }
});

test('planCta ON: unchanged (checkout for a Free viewer, sign-in for a visitor)', () => {
  assert.deepEqual(planCta('pro', true, 'free', 'pro', true), { kind: 'checkout', primary: true });
  assert.deepEqual(planCta('studio', true, 'free', 'pro', true), { kind: 'checkout', primary: false });
  assert.deepEqual(planCta('pro', false, null, 'pro', true), { kind: 'sign-in', primary: true });
  assert.deepEqual(planCta('studio', false, null, 'pro', true), { kind: 'sign-in', primary: false });
});

test('error copy: CHECKOUT_DISABLED has one-sentence headline and action', () => {
  assert.ok(ERROR_COPY.CHECKOUT_DISABLED, 'CHECKOUT_DISABLED missing from ERROR_COPY');
  assert.match(ERROR_COPY.CHECKOUT_DISABLED.headline, /beta/);
});

// ── 3. the checkout route ────────────────────────────────────────────────────
const nextStub = dataUrl(`
  export class NextRequest {}
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }`);
const authStub = dataUrl(`
  export async function getUser() {
    globalThis.__calls.push('auth');
    return { user_id: '00000000-0000-0000-0000-000000000001', email: 'a@example.com' };
  }`);
const billingStub = dataUrl(`
  export function getBillingProvider() {
    globalThis.__calls.push('provider');
    return {
      name: 'stripe',
      createCustomer: async () => { globalThis.__calls.push('createCustomer'); return { providerCustomerId: 'cus_test' }; },
      createCreditPurchaseSession: async () => { globalThis.__calls.push('credits'); return { sessionId: 'cs_1', url: 'https://checkout.test/credits' }; },
      createCheckoutSession: async () => { globalThis.__calls.push('subscription'); return { sessionId: 'cs_2', url: 'https://checkout.test/sub' }; },
      applyPromoCode: async () => {},
    };
  }`);
const dbStub = dataUrl(`
  export const db = {
    tx: async (fn) => { globalThis.__calls.push('db'); return fn({ query: async (sql) => (/COUNT/.test(sql) ? { rows: [{ n: '0' }] } : { rows: [] }) }); },
    query: async () => { globalThis.__calls.push('db'); return { rows: [] }; },
  };`);
const hcaptchaStub = dataUrl(`export async function verifyHcaptchaToken() { globalThis.__calls.push('hcaptcha'); return { success: true }; }`);

async function loadRoute() {
  const js = toJs(read('src/app/api/billing/checkout/route.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${hcaptchaStub}'`);
  return import(dataUrl(wirePureLibs(js)) + '#' + Math.random());
}
const makeReq = (body) => {
  const req = {
    headers: new Headers({ origin: 'https://stem-loops.com', host: 'stem-loops.com' }),
    json: async () => { globalThis.__calls.push('body'); return body; },
  };
  return req;
};

for (const [label, env] of [['unset', undefined], ['empty', ''], ['TRUE', 'TRUE'], ['1', '1']]) {
  for (const body of [{ plan_code: 'pro' }, { plan_code: 'studio' }, { pack_code: 'credits_20', hcaptcha_token: 'ok' }]) {
    test(`route OFF (${label}): ${JSON.stringify(body)} -> 403 CHECKOUT_DISABLED; no auth, body, DB or provider call`, async () => {
      if (env !== undefined) process.env[ENV] = env;
      const { POST } = await loadRoute();
      const res = await POST(makeReq(body));
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'CHECKOUT_DISABLED');
      assert.equal(res.body.checkout_url, undefined);
      assert.deepEqual(globalThis.__calls, [], `reached: ${globalThis.__calls.join(', ')}`);
    });
  }
}

test('route OFF: a cross-origin request is still refused as BAD_ORIGIN first (CSRF order kept)', async () => {
  const { POST } = await loadRoute();
  const res = await POST({ headers: new Headers({ origin: 'https://evil.example', host: 'stem-loops.com' }), json: async () => ({ plan_code: 'pro' }) });
  assert.equal(res.status, 403);
  assert.notEqual(res.body.code, 'CHECKOUT_DISABLED');
  assert.deepEqual(globalThis.__calls, []);
});

test('route ON: the plan path is unchanged — auth, DB, provider, then a session url', async () => {
  process.env[ENV] = 'true';
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ plan_code: 'pro' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.test/sub');
  assert.ok(globalThis.__calls.includes('auth') && globalThis.__calls.includes('subscription'), globalThis.__calls.join(', '));
});

test('route ON: the credit-pack path is unchanged — hCaptcha, then a credit session url', async () => {
  process.env[ENV] = 'true';
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ pack_code: 'credits_60', hcaptcha_token: 'ok' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.test/credits');
  assert.ok(globalThis.__calls.includes('hcaptcha') && globalThis.__calls.includes('credits'), globalThis.__calls.join(', '));
});

// ── 4. /pricing rendered ─────────────────────────────────────────────────────
const USER = { user_id: '22222222-2222-2222-2222-222222222222', email: 'u@x.co' };
const PLANS = [
  { code: 'free', display_name: 'Free', price_cad_cents: 0, monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'pro', display_name: 'Pro', price_cad_cents: 499, monthly_job_quota: 50, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'studio', display_name: 'Studio', price_cad_cents: 1200, monthly_job_quota: 150, services: ['youtube'], export_stems: true, export_wav24: false },
];
const PACKS = [
  { pack_code: 'credits_20', credits: 20, price_cad_cents: 500, display_name: '20 credits' },
  { pack_code: 'credits_60', credits: 60, price_cad_cents: 1200, display_name: '60 credits' },
  { pack_code: 'credits_180', credits: 180, price_cad_cents: 3000, display_name: '180 credits' },
];
function* walkTree(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) yield* walkTree(n); return; }
  yield node;
  if (node.props && 'children' in node.props) yield* walkTree(node.props.children);
}
const fnName = (t) => (typeof t === 'function' ? t.name : String(t));

for (const [who, user] of [['signed out', null], ['signed in on Free', USER]]) {
  test(`/pricing OFF, ${who}: prices shown, no purchase control or link, no hCaptcha, no lime`, async () => {
    const html = await renderPricingPage({ user, plans: PLANS, packs: PACKS, plan: 'free' });
    for (const p of ['$4.99 CAD', '$12 CAD', '$5 CAD', '$30 CAD']) assert.ok(html.includes(p), `price ${p} missing`);
    assert.doesNotMatch(html, /Get Pro|Get Studio|Buy credits/);
    assert.doesNotMatch(html, /login\?return_to=\/pricing/, 'a sign-in link to buy is still shown');
    assert.doesNotMatch(html, /plan_code|billing\/checkout/);
    assert.doesNotMatch(html, /<button\b/, 'a button is rendered while checkout is off');
    assert.deepEqual(limeFills(html), []);
    assert.doesNotMatch(html, /pr-featured/);
    const n = [...html.matchAll(/data-testid="checkout-unavailable"[^>]*>Coming soon — free during the beta</g)].length;
    assert.equal(n, 2 + PACKS.length, 'Pro, Studio and every pack carry the beta copy');
    const tree = await pricingPageTree({ user, plans: PLANS, packs: PACKS, plan: 'free' });
    const found = [...walkTree(tree)].map((el) => fnName(el.type)).filter((n) => /BillingButton|PackBuyButton|CreditPackCheckout/.test(n));
    assert.deepEqual(found, [], `purchase components in the tree: ${found.join(', ')}`);
  });
}

test('/pricing OFF, a Pro subscriber: Current plan and the /account links are unchanged', async () => {
  const html = await renderPricingPage({ user: USER, plans: PLANS, packs: PACKS, plan: 'pro' });
  assert.match(html, /Current plan/);
  assert.match(html, /<a href="\/account" class="pr-cta pr-cta-quiet">Change plan<\/a>/);
});

test('/pricing ON: a Free viewer gets the plan checkouts and pack buttons back', async () => {
  process.env[ENV] = 'true';
  const html = await renderPricingPage({ user: USER, plans: PLANS, packs: PACKS, plan: 'free' });
  assert.match(html, /Get Pro/);
  assert.match(html, /Buy credits/);
  assert.doesNotMatch(html, /Coming soon/);
  assert.deepEqual(limeFills(html), ['button Get Pro']);
});

// ── 5. entry-point inventory ─────────────────────────────────────────────────
test('inventory: purchase components are rendered only by app/pricing/page.tsx', () => {
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const offenders = walk(join(WEB, 'src'))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    // The file that defines the components (its own comments name them) is not a caller.
    .filter((f) => relative(WEB, f) !== 'src/components/BillingButton.tsx')
    .filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /<PackBuyButton\b|<CreditPackCheckout\b|<BillingButton\b[^>]*\/api\/billing\/checkout/.test(s);
    })
    .map((f) => relative(WEB, f));
  assert.deepEqual(offenders, ['src/app/pricing/page.tsx']);
});
