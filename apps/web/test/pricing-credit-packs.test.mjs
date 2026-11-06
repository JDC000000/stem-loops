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
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRICING_SRC = join(WEB, 'src/app/pricing/page.tsx');

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
      return createElement('button', { 'data-pack': props.packCode }, props.label);
    }
    export function CreditPackCheckout(props) {
      return createElement('div', { 'data-pack-checkout': true }, props.children);
    }
  `);
}

async function loadPricing({ user = null, plans = null, packs = null, throwPlans = false, throwPacks = false } = {}) {
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
    .replace(/from ['"]@\/components\/BillingButton['"]/g, `from '${await billingButtonStub()}'`);
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
