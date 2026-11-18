// Run: pnpm --filter web test
//
// QA A-10 (track A, 2026-11-18): signed in, /pricing was not plan-aware. A Free user was
// offered "Start free" (a link home) and a Pro subscriber "Get Pro". The viewer's own plan
// now reads "Current plan" (neutral: not lime, not a control), the NEXT plan up carries the
// page's one lime fill and the highlight, and nothing points back to a plan you are above
// except a quiet "Manage plan" link to /account. Display only: the checkout buttons are the
// unchanged BillingButton, and nothing here reaches checkout or Stripe.
//
// HARNESS: the WHOLE page server-rendered with the REAL BillingButton.tsx and pricing-copy.ts
// (test/helpers/render-pricing-page.mjs); only the DB, the session and the entitlement read
// are stubbed. The lime check reads the rendered paint (limeFills), not props.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPricingPage, limeFills, pricingPageTree } from './helpers/render-pricing-page.mjs';
import { featuredPlan, planCta } from '../src/lib/pricing-copy.ts';

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

/** Each plan card's markup, by display name. */
function cards(html) {
  return Object.fromEntries([...html.matchAll(/<section class="([^"]*)" aria-label="(Free|Pro|Studio)">([\s\S]*?)<\/section>/g)].map((m) => [m[2], { cls: m[1], html: m[3] }]));
}
const render = (user, plan, extra = {}) => renderPricingPage({ user, plans: PLANS, packs: PACKS, plan, ...extra });
const text = (h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

function assertCurrent(card, name) {
  const m = card.html.match(/<(\w+)[^>]*data-testid="plan-current"[^>]*>([\s\S]*?)<\/\1>/);
  assert.ok(m, `${name}: no "Current plan" marker`);
  assert.equal(m[2].trim(), 'Current plan');
  assert.ok(!['a', 'button'].includes(m[1]), `${name}: "Current plan" is a control (${m[1]})`);
  assert.doesNotMatch(m[0], /jp-primary|--accent|--btn-primary-bg|#a3e635/i, `${name}: "Current plan" is lime`);
  assert.doesNotMatch(card.html, /<(?:a|button)\b/, `${name}: the current plan still offers an action`);
}

test('A-10: a Free user sees "Current plan" on Free, never "Start free"; Get Pro is the one lime fill', async () => {
  const html = await render(USER, 'free');
  const c = cards(html);
  assert.doesNotMatch(html, /Start free/, '"Start free" shown to a signed-in Free user');
  assertCurrent(c.Free, 'Free');
  assert.deepEqual(limeFills(html), ['button Get Pro']);
  assert.match(c.Pro.cls, /\bpr-featured\b/);
  assert.match(text(c.Studio.html), /Get Studio/);
});

// ── review of #301, F-1 (money): /api/billing/checkout opens a NEW subscription and
// does not check for an existing one, so a paying viewer must never be offered one. ──
function* walkTree(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) yield* walkTree(n); return; }
  yield node;
  if (node.props && 'children' in node.props) yield* walkTree(node.props.children);
}
/** Every way the page could start a PLAN checkout: a component handed a plan_code or the
 *  checkout endpoint with a plan body, a form posting there, or the endpoint in the markup. */
async function planCheckouts(plan, extra = {}) {
  const found = [];
  const tree = await pricingPageTree({ user: USER, plans: PLANS, packs: PACKS, plan, ...extra });
  for (const el of walkTree(tree)) {
    const p = el.props ?? {};
    if (p.body && typeof p.body === 'object' && 'plan_code' in p.body) found.push(`component with body.plan_code=${p.body.plan_code}`);
    if (p.endpoint === '/api/billing/checkout' && !p.packCode) found.push(`component posting to ${p.endpoint}`);
    if (el.type === 'form' && /checkout/.test(String(p.action ?? ''))) found.push(`form action ${p.action}`);
  }
  const html = await render(USER, plan, extra);
  if (/plan_code/.test(html)) found.push('plan_code in the markup');
  if (/<form[^>]*billing\/checkout/.test(html)) found.push('a form posting to checkout');
  for (const m of html.matchAll(/<button[^>]*>(Get (?:Pro|Studio|Free))<\/button>/g)) found.push(`button "${m[1]}"`);
  return found;
}

test('harness: a Free viewer DOES get plan checkouts (so the check below can see one)', async () => {
  const found = await planCheckouts('free');
  assert.ok(found.some((f) => /plan_code=pro/.test(f)) && found.some((f) => /plan_code=studio/.test(f)), found.join('; '));
});

for (const plan of ['pro', 'studio']) {
  test(`F-1: a ${plan} subscriber's /pricing has NO action that posts plan_code to /api/billing/checkout`, async () => {
    assert.deepEqual(await planCheckouts(plan), [], `a ${plan} subscriber is offered a second subscription`);
  });
}

test('A-10 / F-1: a Pro subscriber sees "Current plan" on Pro, "Change plan" on Studio (to /account), and no lime', async () => {
  const html = await render(USER, 'pro');
  const c = cards(html);
  assert.doesNotMatch(html, /Get Pro|Get Studio|Start free/);
  assertCurrent(c.Pro, 'Pro');
  assert.match(c.Studio.html, /<a href="\/account" class="pr-cta pr-cta-quiet">Change plan<\/a>/);
  assert.match(c.Free.html, /<a href="\/account" class="pr-cta pr-cta-quiet">Manage plan<\/a>/);
  assert.deepEqual(limeFills(html), [], 'no lime: there is nothing to buy here');
  for (const n of ['Free', 'Pro', 'Studio']) assert.doesNotMatch(c[n].cls, /\bpr-featured\b/);
});

test('A-10 / F-1: a Studio subscriber sees "Current plan" on Studio, "Change plan" on Pro, and no lime', async () => {
  const html = await render(USER, 'studio');
  const c = cards(html);
  assert.doesNotMatch(html, /Get Pro|Get Studio|Start free/);
  assertCurrent(c.Studio, 'Studio');
  assert.match(c.Pro.html, />Change plan<\/a>/);
  assert.match(c.Free.html, />Manage plan<\/a>/);
  assert.deepEqual(limeFills(html), []);
  for (const n of ['Free', 'Pro', 'Studio']) assert.doesNotMatch(c[n].cls, /\bpr-featured\b/);
});

test('A-10: signed out is unchanged — Start free, and Get Pro through sign-in is the one lime fill', async () => {
  const html = await render(null, 'free');
  assert.match(html, /<a href="\/" class="pr-cta pr-cta-quiet">Start free<\/a>/);
  assert.deepEqual(limeFills(html), ['a Get Pro']);
  assert.doesNotMatch(html, /Current plan/);
});

test('F-2: signed in but the plan cannot be read — no plan checkout at all, a neutral note, no lime', async () => {
  const html = await render(USER, null);
  assert.doesNotMatch(html, /Start free|Current plan|Get Pro|Get Studio/);
  assert.deepEqual(limeFills(html), []);
  assert.match(html, /data-testid="plan-unknown"[^>]*>We couldn(?:&#x27;|')t load your current plan just now\./);
  const c = cards(html);
  for (const n of ['Free', 'Pro', 'Studio']) assert.match(c[n].html, /<a href="\/account" class="pr-cta pr-cta-quiet">Manage plan<\/a>/, n);
  for (const n of ['Free', 'Pro', 'Studio']) assert.doesNotMatch(c[n].cls, /\bpr-featured\b/, `${n} is highlighted for a viewer of unknown plan`);
  assert.deepEqual(await planCheckouts(null), []);
  // A plan code this page does not know is treated the same way.
  assert.deepEqual(await planCheckouts('enterprise'), []);
});

// ── review of #301, R2-2 (money): "Free" on /pricing is the EFFECTIVE plan
// (effectivePlanCode), which reads 'free' for viewers who still hold a live
// subscription that a new checkout would duplicate. Each state below has effective
// plan 'free' (the reviewer ran the real effectivePlanCode over them); the page must
// treat each as unknown: Manage plan, the neutral note, no checkout, no lime. ──
const STRIPE = (status) => ({ provider: 'stripe', status });
const LIVE_BUT_FREE = [
  ['past_due beyond the 7-day grace', { subs: [STRIPE('past_due')], entPlan: 'pro' }],
  ['paused', { subs: [STRIPE('paused')], entPlan: 'pro' }],
  ['active, entitlements period_end lapsed (late renewal webhook)', { subs: [STRIPE('active')], entPlan: 'pro' }],
  ['trialing with a lapsed period', { subs: [STRIPE('trialing')], entPlan: 'studio' }],
  ['incomplete (first payment / 3DS pending)', { subs: [STRIPE('incomplete')], entPlan: 'free' }],
  ['entitlements row on a paid plan, no subscriptions row yet', { subs: [], entPlan: 'pro' }],
  ['a canceled sub AND a live paused one', { subs: [STRIPE('canceled'), STRIPE('paused')], entPlan: 'pro' }],
  ['the subscription read fails', { subsThrow: true }],
];
for (const [name, state] of LIVE_BUT_FREE) {
  test(`R2-2: effective Free but ${name} — no plan checkout, Manage plan and the note`, async () => {
    assert.deepEqual(await planCheckouts('free', state), [], `${name}: a second subscription is offered`);
    const html = await render(USER, 'free', state);
    assert.deepEqual(limeFills(html), [], `${name}: lime on the page`);
    assert.match(html, /data-testid="plan-unknown"/, `${name}: no neutral note`);
    assert.doesNotMatch(html, /Current plan|Start free/, `${name}: Free is presented as the current plan`);
    const c = cards(html);
    for (const n of ['Free', 'Pro', 'Studio']) assert.match(c[n].html, /<a href="\/account" class="pr-cta pr-cta-quiet">Manage plan<\/a>/, `${name}: ${n}`);
  });
}

for (const [name, state] of [
  ['canceled-only (one canceled subscription)', { subs: [STRIPE('canceled')], entPlan: 'pro' }],
  ['canceled twice, entitlements row back on free', { subs: [STRIPE('canceled'), STRIPE('canceled')], entPlan: 'free' }],
  ['never subscribed (no rows)', { subs: [], entPlan: null }],
  ['a live sub with ANOTHER provider only', { subs: [{ provider: 'paddle', status: 'active' }], entPlan: 'free' }],
]) {
  test(`R2-2: ${name} is plainly Free and CAN (re)subscribe — checkout shown, Get Pro the one lime`, async () => {
    const found = await planCheckouts('free', state);
    assert.ok(found.some((f) => /plan_code=pro/.test(f)) && found.some((f) => /plan_code=studio/.test(f)), `${name}: resubscribing is blocked (${found.join('; ')})`);
    const html = await render(USER, 'free', state);
    assert.deepEqual(limeFills(html), ['button Get Pro']);
    assert.doesNotMatch(html, /data-testid="plan-unknown"/);
  });
}

test('A-10: the decision table (pure)', () => {
  const codes = ['free', 'pro', 'studio'];
  assert.equal(featuredPlan(codes, false, null), 'pro');
  assert.equal(featuredPlan(codes, true, 'free'), 'pro');
  assert.equal(featuredPlan(codes, true, 'pro'), null);
  assert.equal(featuredPlan(codes, true, 'studio'), null);
  assert.equal(featuredPlan(codes, true, null), null);
  assert.deepEqual(planCta('free', true, 'free', 'pro'), { kind: 'current' });
  assert.deepEqual(planCta('pro', true, 'studio', null), { kind: 'change' });
  assert.deepEqual(planCta('studio', true, 'pro', null), { kind: 'change' });
  assert.deepEqual(planCta('free', true, 'pro', null), { kind: 'manage' });
  assert.deepEqual(planCta('pro', true, null, null), { kind: 'manage' });
  assert.deepEqual(planCta('studio', true, 'free', 'pro'), { kind: 'checkout', primary: false });
  assert.deepEqual(planCta('free', false, null, 'pro'), { kind: 'start-free' });
});
