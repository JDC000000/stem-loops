// /pricing — credit packs render DB-driven, with FALLBACK only when the DB
// read fails or returns zero rows (audit MINOR, session-4 holistic audit).
//
// Load approach parallels claim-jobs.test.mjs / trial.test.mjs: transpile
// the server component in-memory, replace the imported modules with
// data-URL stubs, then invoke the default export and inspect the React
// tree. No real DB, no real network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { renderPricingPage, loadBillingButton, limeFills } from './helpers/render-pricing-page.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRICING_SRC = join(WEB, 'src/app/pricing/page.tsx');
const walkDir = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walkDir(p) : [p]; });
const CODE_TSX = walkDir(join(WEB, 'src')).filter((p) => /\.tsx$/.test(p) && !/\.test\./.test(p));

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      // Classic React runtime: `React.createElement(...)` — needs `React` in
      // scope. We inject an `import React from 'react'` after transpile so the
      // data-URL module resolves it through node_modules (the ReactJSX runtime
      // emits a `react/jsx-runtime` specifier that data-URL imports can't
      // resolve relative to node_modules).
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

function dbStub({ plans, packs, throwPlans, throwPacks } = {}) {
  const payload = JSON.stringify({ plans: plans ?? null, packs: packs ?? null, throwPlans: !!throwPlans, throwPacks: !!throwPacks });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__pricingQueries = [];
    export const db = {
      query: async (text) => {
        globalThis.__pricingQueries.push(text);
        if (/public\\.plans/.test(text)) {
          if (cfg.throwPlans) throw new Error('plans down');
          return { rows: cfg.plans ?? [] };
        }
        if (/public\\.credit_packs/.test(text)) {
          if (cfg.throwPacks) throw new Error('credit_packs down');
          return { rows: cfg.packs ?? [] };
        }
        return { rows: [] };
      },
    };
  `);
}

function authStub(user) {
  return dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`);
}

// QA A-10: the page reads the viewer's plan from the entitlement snapshot. `plan` is that
// snapshot's plan_code; `throwPlan` makes the read fail (the page must still render).
function entitlementsStub(plan, throwPlan) {
  return dataUrl(`export const getEntitlementSnapshot = async () => { ${throwPlan ? "throw new Error('entitlements down');" : ''} return { plan_code: ${JSON.stringify(plan)} }; };`);
}

function trialStub() {
  // Keep it simple — pricing just needs readTrial not to crash.
  return dataUrl(`
    export const TRIAL_SONG_CAP = 3;
    export const readTrial = async () => ({ present: true });
  `);
}

async function billingButtonStub() {
  const reactSrc = (await import('node:module')).createRequire(import.meta.url).resolve('react');
  const reactUrl = 'file://' + reactSrc;
  return dataUrl(`
    import { createElement } from '${reactUrl}';
    export default function BillingButton(props) {
      return createElement('button', { 'data-plan': props.body && props.body.plan_code }, props.label);
    }
    export function PackBuyButton(props) {
      return createElement('button', { 'data-pack': props.packCode, 'data-variant': props.variant }, props.label);
    }
    export function CreditPackCheckout(props) {
      return createElement('div', { 'data-pack-checkout': true }, props.children);
    }
  `);
}

// The real src/lib/pricing-copy.ts, transpiled to a data URL. Not a stub: it has
// no imports of its own, so it needs nothing rewritten.
function pricingCopyModule() {
  return dataUrl(toJs(readFileSync(join(WEB, 'src/lib/pricing-copy.ts'), 'utf8')));
}

async function loadPricing({ user = null, plans = null, packs = null, throwPlans = false, throwPacks = false, plan = 'free', throwPlan = false } = {}) {
  globalThis.__pricingQueries = [];
  // Resolve `react` to its absolute file:// URL so the data-URL module can
  // `import React from 'react'` (data-URL imports can't look up bare
  // specifiers through node_modules).
  const reactSrc = (await import('node:module')).createRequire(import.meta.url).resolve('react');
  const reactUrl = 'file://' + reactSrc;
  let js = toJs(readFileSync(PRICING_SRC, 'utf8'));
  js = `import React from '${reactUrl}';\n` + js;
  js = js
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub({ plans, packs, throwPlans, throwPacks })}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${trialStub()}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${entitlementsStub(plan, throwPlan)}'`)
    // R2-2: a plain Free viewer here (no live subscription); the states are pinned in pricing-plan-aware.test.mjs.
    .replace(/from ['"]@\/lib\/billing\/pricing-plan-state['"]/g, `from '${dataUrl('export const freeViewerHasLiveSubscription = async () => false;')}'`)
    .replace(/from ['"]@\/components\/BillingButton['"]/g, `from '${await billingButtonStub()}'`)
    // The feature bullets moved to src/lib/pricing-copy.ts: a Next.js App Router
    // page may only export a fixed set of fields, so the page cannot export
    // features()/quotaLine() itself. Inline the REAL module rather than a stub —
    // these tests render the page, and stubbing the bullets would make the
    // rendered output stop being the page's own.
    .replace(/from ['"]@\/lib\/pricing-copy['"]/g, `from '${pricingCopyModule()}'`);
  // Cache-bust so successive tests get fresh module state.
  return await import(dataUrl(js) + '#' + Math.random());
}

// Walk a React element tree, yielding every element.
function* walk(node) {
  if (!node || typeof node !== 'object') return;
  yield node;
  const children = node.props && node.props.children;
  if (!children) return;
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) yield* walk(c);
}

// Collect the text content of an element (depth-first).
function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object' || !node.props) return '';
  return textOf(node.props.children);
}

const USER = { user_id: '22222222-2222-2222-2222-222222222222', email: 'u@x.co' };
const PLANS_OK = [
  { code: 'free', display_name: 'Free', price_cad_cents: 0, monthly_job_quota: 90, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'pro', display_name: 'Pro', price_cad_cents: 499, monthly_job_quota: 100000, services: [], export_stems: true, export_wav24: false },
  { code: 'studio', display_name: 'Studio', price_cad_cents: 1200, monthly_job_quota: 100000, services: [], export_stems: true, export_wav24: true },
];
const PACKS_OK = [
  { pack_code: 'credits_20', credits: 20, price_cad_cents: 500, display_name: '20 credits' },
  { pack_code: 'credits_60', credits: 60, price_cad_cents: 1200, display_name: '60 credits' },
  { pack_code: 'credits_180', credits: 180, price_cad_cents: 3000, display_name: '180 credits' },
];

// Happy path: the page runs a SELECT against public.credit_packs and the
// rendered output reflects what the DB returned.
test('pricing page queries public.credit_packs', async () => {
  const mod = await loadPricing({ user: USER, plans: PLANS_OK, packs: PACKS_OK });
  await mod.default();
  const queries = globalThis.__pricingQueries;
  assert.ok(queries.some((q) => /FROM public\.credit_packs/i.test(q)), `expected a credit_packs SELECT, got: ${queries.join(' | ')}`);
  assert.ok(queries.some((q) => /WHERE active = true/i.test(q)), 'credit_packs query must filter on active = true');
});

// DB rows drive the render — the DB's price/credits/display_name text
// appears, not the FALLBACK constant's (we use distinct values to tell).
test('pricing page renders credit packs from DB, not from FALLBACK', async () => {
  const dbPacks = [
    // Intentionally different ORDER and PRICES than FALLBACK so the test
    // proves the DB rows (not the in-file constant) drive the render.
    { pack_code: 'credits_60',  credits: 60,  price_cad_cents: 1200, display_name: '60 credits'  },
    { pack_code: 'credits_20',  credits: 20,  price_cad_cents: 500,  display_name: '20 credits'  },
    { pack_code: 'credits_180', credits: 180, price_cad_cents: 3000, display_name: '180 credits' },
  ];
  const mod = await loadPricing({ user: USER, plans: PLANS_OK, packs: dbPacks });
  const tree = await mod.default();
  // Scan the rendered tree for BillingButton stub children carrying pack codes.
  const buttons = [];
  for (const el of walk(tree)) {
    if (el && el.type && typeof el.type === 'function' && el.props && el.props.packCode) {
      buttons.push(el.props.packCode);
    }
  }
  // All three pack buy buttons are present.
  assert.deepEqual([...buttons].sort(), ['credits_180', 'credits_20', 'credits_60']);
  // And price text from the DB rows appears somewhere in the tree.
  const text = textOf(tree);
  assert.match(text, /\$5\s*CAD/, 'DB pack 1 price ($5) must render');
  assert.match(text, /\$12\s*CAD/, 'DB pack 2 price ($12) must render');
  assert.match(text, /\$30\s*CAD/, 'DB pack 3 price ($30) must render');
});

// Degraded mode: DB throws → FALLBACK array renders and the banner shows.
test('pricing page falls back to constant + shows degraded banner when credit_packs query throws', async () => {
  const mod = await loadPricing({ user: USER, plans: PLANS_OK, throwPacks: true });
  const tree = await mod.default();
  const text = textOf(tree);
  // All three fallback packs still render (prices from the FALLBACK constant).
  assert.match(text, /20 credits/);
  assert.match(text, /60 credits/);
  assert.match(text, /180 credits/);
  assert.match(text, /\$5\s*CAD/);
  assert.match(text, /\$12\s*CAD/);
  assert.match(text, /\$30\s*CAD/);
  // The audit-era degraded banner must fire when EITHER catalog degrades.
  assert.match(text, /live plan data is temporarily unavailable/i);
});

// Degraded mode via empty rows (table exists but was truncated, e.g.
// mid-migration): also falls back to FALLBACK array.
test('pricing page falls back when credit_packs returns zero rows', async () => {
  const mod = await loadPricing({ user: USER, plans: PLANS_OK, packs: [] });
  const tree = await mod.default();
  const text = textOf(tree);
  assert.match(text, /20 credits/);
  assert.match(text, /live plan data is temporarily unavailable/i);
});

// Only plans degraded → still shows the banner (packs still DB-driven).
test('pricing page shows degraded banner when only plans query throws', async () => {
  const mod = await loadPricing({ user: USER, throwPlans: true, packs: PACKS_OK });
  const tree = await mod.default();
  const text = textOf(tree);
  assert.match(text, /live plan data is temporarily unavailable/i);
  // Packs rendered from DB rows.
  assert.match(text, /20 credits/);
});

// Both OK → banner absent.
test('pricing page omits degraded banner when both queries succeed', async () => {
  const mod = await loadPricing({ user: USER, plans: PLANS_OK, packs: PACKS_OK });
  const tree = await mod.default();
  const text = textOf(tree);
  assert.doesNotMatch(text, /live plan data is temporarily unavailable/i);
});

// Layout/money-path guard: exactly ONE captcha owner for the pack grid. The
// cards must not embed their own BillingButton for pack purchases (that put an
// hCaptcha widget in every card and overflowed at 768px / clipped at 375px).
test('pricing pack cards use one shared CreditPackCheckout, not per-card captchas', async () => {
  const mod = await loadPricing({ user: USER, plans: PLANS_OK, packs: PACKS_OK });
  const tree = await mod.default();
  let wrappers = 0;
  let packBillingButtons = 0;
  for (const el of walk(tree)) {
    if (el && el.props && el.props.returnTo === '/pricing' && el.props.children && !el.props.endpoint) wrappers++;
    if (el && typeof el.type === 'function' && el.props && el.props.body && el.props.body.pack_code) packBillingButtons++;
  }
  assert.equal(wrappers, 1, 'exactly one CreditPackCheckout wrapper');
  assert.equal(packBillingButtons, 0, 'no per-card BillingButton with pack_code');
});

test('BillingButton source: hCaptcha is instantiated once, outside any per-card component', () => {
  const src = readFileSync(join(WEB, 'src/components/BillingButton.tsx'), 'utf8');
  assert.equal((src.match(/^\s*<HCaptcha\s/gm) ?? []).length, 1, 'single <HCaptcha> element in the file');
  assert.match(src, /export function CreditPackCheckout/);
  assert.match(src, /export function PackBuyButton/);
});

// ---------------------------------------------------------------------------
// P6 (Jon, 2026-11-17): the plan cards, read off the rendered tree.
// ---------------------------------------------------------------------------
const PLANS_034 = [
  { code: 'free', display_name: 'Free', price_cad_cents: 0, monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'pro', display_name: 'Pro', price_cad_cents: 499, monthly_job_quota: 50, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'studio', display_name: 'Studio', price_cad_cents: 1200, monthly_job_quota: 150, services: ['youtube'], export_stems: true, export_wav24: false },
];

function planSections(tree) {
  const out = {};
  for (const el of walk(tree)) {
    if (el && el.type === 'section' && ['Free', 'Pro', 'Studio'].includes(el.props['aria-label'])) out[el.props['aria-label']] = el;
  }
  return out;
}

for (const user of [null, USER]) {
  test(`P6 cards (${user ? 'signed in' : 'signed out'}): every price shows CAD, Free included; each card leads with its benefit`, async () => {
    const mod = await loadPricing({ user, plans: PLANS_034, packs: PACKS_OK });
    const s = planSections(await mod.default());
    assert.deepEqual(Object.keys(s), ['Free', 'Pro', 'Studio']);
    assert.match(textOf(s.Free), /\$0 CAD/);
    assert.match(textOf(s.Pro), /\$4\.99 CAD/);
    assert.match(textOf(s.Studio), /\$12 CAD/);
    // No bare "$0" (the old formatter printed Free without a currency).
    const all = textOf(await mod.default());
    const prices = [...all.matchAll(/\$[\d.]+(.{0,4})/g)];
    assert.ok(prices.length >= 6, `expected 3 plan + 3 pack prices, found ${prices.length}`);
    for (const m of prices) assert.ok(m[1].startsWith(' CAD'), `price without currency: ${m[0]}`);
    // The benefit line comes before the price and the bullets (it LEADS the card).
    // Retention is said once, in RETENTION_BULLET's exact words, never paraphrased.
    assert.ok(textOf(s.Free).includes('Songs deleted after 24 hours'));
    for (const n of ['Pro', 'Studio']) assert.ok(textOf(s[n]).includes('Song library: kept while you subscribe, plus 30 days'), n);
    assert.doesNotMatch(all, /library is kept/i);
    for (const [name, line] of [['Free', '5 songs a month'], ['Pro', '50 songs a month'], ['Studio', '150 songs a month']]) {
      const t = textOf(s[name]);
      assert.ok(t.includes(line), `${name}: ${t}`);
      assert.ok(t.indexOf(line) < t.indexOf('$'), `${name}: the benefit line must come before the price`);
    }
  });
}

test('P6: Pro is the one highlighted card, with no badge or ranking claim', async () => {
  const mod = await loadPricing({ user: null, plans: PLANS_034, packs: PACKS_OK });
  const tree = await mod.default();
  const s = planSections(tree);
  assert.match(s.Pro.props.className, /\bpr-featured\b/);
  assert.doesNotMatch(s.Free.props.className, /\bpr-featured\b/);
  assert.doesNotMatch(s.Studio.props.className, /\bpr-featured\b/);
  // "Recommended" and "most popular" are both unbacked claims (no data): neither is shown.
  assert.doesNotMatch(textOf(tree), /recommended|most popular|best value|popular/i);
});

// Brand rule A5: lime fills the view's ONE primary action, and on /pricing that is Get Pro.
// Signed out, it is Pro's link; the rest are outlined. Signed in, the plan buttons follow
// BillingButton's own `primary` prop, and the credit-pack buttons ask PackBuyButton for its
// `variant="quiet"` (the brand secondary). The P6 residue that left the signed-in pack buttons
// lime (S-2 on #287's review) is closed by the [billing] PR that added that variant. The tests
// below read the PROPS the page passes; the rendered paint is pinned further down against the
// real BillingButton.tsx, and in brand-tokens.test.mjs.
test('P6 (A5): signed out, exactly one lime action on the page — Get Pro', async () => {
  const mod = await loadPricing({ user: null, plans: PLANS_034, packs: PACKS_OK });
  const tree = await mod.default();
  const primaries = [...walk(tree)].filter((el) => el && el.type === 'a' && /\bjp-primary\b/.test(el.props.className ?? ''));
  assert.deepEqual(primaries.map(textOf), ['Get Pro']);
  for (const el of walk(tree)) if (el && el.type === 'a') assert.match(el.props.className ?? '', /\bpr-cta\b/, `${textOf(el)} is not a 44px pr-cta`);
});

test('P6 (A5): signed in, only Pro\'s plan button is primary', async () => {
  const mod = await loadPricing({ user: USER, plans: PLANS_034, packs: PACKS_OK });
  const tree = await mod.default();
  const plan = [...walk(tree)].filter((el) => el && typeof el.type === 'function' && el.props?.body?.plan_code);
  assert.deepEqual(plan.map((el) => [el.props.body.plan_code, el.props.primary]), [['pro', true], ['studio', false]]);
});

test('A5: signed in, every credit-pack button asks for the quiet variant', async () => {
  const mod = await loadPricing({ user: USER, plans: PLANS_034, packs: PACKS_OK });
  const tree = await mod.default();
  const packs = [...walk(tree)].filter((el) => el && typeof el.type === 'function' && el.props?.packCode);
  assert.deepEqual(packs.map((el) => [el.props.packCode, el.props.variant]),
    [['credits_20', 'quiet'], ['credits_60', 'quiet'], ['credits_180', 'quiet']]);
});

// ---------------------------------------------------------------------------
// The paint, not the props: the real BillingButton.tsx, server-rendered.
// ---------------------------------------------------------------------------
test('A5 (rendered): signed in, /pricing has exactly one lime fill — Get Pro', async () => {
  const html = await renderPricingPage({ user: USER, plans: PLANS_034, packs: PACKS_OK });
  assert.deepEqual(limeFills(html), ['button Get Pro']);
  const buy = [...html.matchAll(/<button[^>]*>Buy credits<\/button>/g)].map((m) => m[0]);
  assert.equal(buy.length, 3, 'three pack buttons render');
  for (const b of buy) {
    assert.match(b, /border:1\.5px solid var\(--border-control\)/, 'quiet = the --border-control edge');
    assert.match(b, /font-weight:500/, 'quiet = weight 500');
    assert.match(b, /min-height:44px/, 'quiet keeps the 44px touch target');
    assert.match(b, /background:transparent/);
    assert.doesNotMatch(b, /--border-default|--accent|--btn-primary-bg/);
  }
  const studio = html.match(/<button[^>]*>Get Studio<\/button>/)[0];
  assert.match(studio, /border:1\.5px solid var\(--border-control\)/, 'Studio has a control edge, not --border-default');
  assert.doesNotMatch(studio, /--border-default/);
});

// PackBuyButton's only caller today is /pricing. Any other caller that omits `variant` must
// get exactly what every caller got before the variant existed: the lime primary. The
// expected style string is the pre-change render, copied verbatim.
test('PackBuyButton: the default (no variant) is unchanged — the lime primary', async () => {
  const { React, renderToStaticMarkup, CreditPackCheckout, PackBuyButton } = await loadBillingButton();
  const h = React.createElement;
  const render = (props) => renderToStaticMarkup(
    h(CreditPackCheckout, { returnTo: '/x' }, h(PackBuyButton, { packCode: 'credits_20', label: 'Buy', ...props })));
  const BEFORE = '<button type="button" aria-pressed="false" style="width:100%;min-height:44px;padding:0 16px;'
    + 'border-radius:8px;cursor:pointer;font-weight:600;border:none;background:var(--btn-primary-bg, var(--accent));'
    + 'color:var(--btn-primary-text, #000);opacity:1;outline-offset:2px">Buy</button>';
  assert.equal(render({}), BEFORE);
  assert.equal(render({ variant: 'primary' }), BEFORE);
  assert.notEqual(render({ variant: 'quiet' }), BEFORE);
  // Every caller in src/, so a new one is seen here.
  const callers = CODE_TSX.filter((f) => /<PackBuyButton\b/.test(readFileSync(f, 'utf8'))).map((f) => relative(WEB, f));
  assert.deepEqual(callers, ['src/app/pricing/page.tsx']);
});

test('P6: nothing the catalog cannot back — no annual price, no tempo/pitch, no implementation names', async () => {
  const mod = await loadPricing({ user: null, plans: PLANS_034, packs: PACKS_OK });
  const t = textOf(await mod.default());
  // public.plans has no annual price column (migrations through 039), so none is shown.
  assert.doesNotMatch(t, /annual|yearly|\/yr\b|per year|a year/i);
  // Tempo and pitch are not built; they may only appear under "Coming soon", and this page has none.
  assert.doesNotMatch(t, /tempo|pitch|slow (?:a song )?down/i);
  assert.doesNotMatch(t, /demucs|replicate|\bmono\b|24 ?kHz|stripe/i);
});

test('P6: the intro and the credits line are at most two sentences each', async () => {
  const mod = await loadPricing({ user: null, plans: PLANS_034, packs: PACKS_OK });
  const tree = await mod.default();
  const ledes = [...walk(tree)].filter((el) => el && el.type === 'p' && el.props.className === 'pr-lede').map(textOf);
  assert.equal(ledes.length, 2);
  for (const l of ledes) {
    const sentences = l.split(/(?<=\.)\s+/).filter(Boolean);
    assert.ok(sentences.length <= 2, `${sentences.length} sentences: ${l}`);
    assert.ok(l.length <= 120, `${l.length} characters: ${l}`);
  }
});
