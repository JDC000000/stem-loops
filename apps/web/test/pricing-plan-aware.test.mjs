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
import { renderPricingPage, limeFills } from './helpers/render-pricing-page.mjs';
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
const render = (user, plan) => renderPricingPage({ user, plans: PLANS, packs: PACKS, plan });
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

test('A-10: a Pro subscriber sees "Current plan" on Pro, never "Get Pro"; the lime moves to Get Studio', async () => {
  const html = await render(USER, 'pro');
  const c = cards(html);
  assert.doesNotMatch(html, /Get Pro|Start free/);
  assertCurrent(c.Pro, 'Pro');
  assert.deepEqual(limeFills(html), ['button Get Studio'], 'exactly one lime fill, on the next upgrade');
  assert.match(c.Studio.cls, /\bpr-featured\b/);
  assert.doesNotMatch(c.Pro.cls, /\bpr-featured\b/);
  assert.match(c.Free.html, /<a href="\/account" class="pr-cta pr-cta-quiet">Manage plan<\/a>/);
});

test('A-10: a Studio subscriber sees "Current plan" on Studio and no lime plan action at all', async () => {
  const html = await render(USER, 'studio');
  const c = cards(html);
  assert.doesNotMatch(html, /Get Pro|Get Studio|Start free/);
  assertCurrent(c.Studio, 'Studio');
  assert.deepEqual(limeFills(html), [], 'nothing to upgrade to: no lime');
  for (const n of ['Free', 'Pro']) assert.match(c[n].html, /Manage plan/, `${n}: no way to manage the plan`);
  for (const n of ['Free', 'Pro', 'Studio']) assert.doesNotMatch(c[n].cls, /\bpr-featured\b/);
});

test('A-10: signed out is unchanged — Start free, and Get Pro through sign-in is the one lime fill', async () => {
  const html = await render(null, 'free');
  assert.match(html, /<a href="\/" class="pr-cta pr-cta-quiet">Start free<\/a>/);
  assert.deepEqual(limeFills(html), ['a Get Pro']);
  assert.doesNotMatch(html, /Current plan/);
});

test('A-10: signed in but the plan cannot be read — the page still renders, with no "Start free" and Pro lime', async () => {
  const html = await render(USER, null);
  assert.doesNotMatch(html, /Start free|Current plan/);
  assert.deepEqual(limeFills(html), ['button Get Pro']);
});

test('A-10: the decision table (pure)', () => {
  const codes = ['free', 'pro', 'studio'];
  assert.equal(featuredPlan(codes, false, null), 'pro');
  assert.equal(featuredPlan(codes, true, 'free'), 'pro');
  assert.equal(featuredPlan(codes, true, 'pro'), 'studio');
  assert.equal(featuredPlan(codes, true, 'studio'), null);
  assert.equal(featuredPlan(codes, true, null), 'pro');
  assert.deepEqual(planCta('free', true, 'free', 'pro'), { kind: 'current' });
  assert.deepEqual(planCta('pro', true, 'studio', null), { kind: 'manage' });
  assert.deepEqual(planCta('studio', true, 'pro', 'studio'), { kind: 'checkout', primary: true });
  assert.deepEqual(planCta('free', false, null, 'pro'), { kind: 'start-free' });
});
