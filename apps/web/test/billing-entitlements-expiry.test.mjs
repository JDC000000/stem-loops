// Paid entitlements must EXPIRE. entitlements.plan_code is only ever written
// upward by the webhook, so readSnapshot must not trust it alone: it gates on
// period_end and the subscription status.
//
// Policy under test (see PAST_DUE_GRACE_MS in entitlements.ts):
//   active/trialing + period_end in future -> paid
//   active/trialing + period_end passed    -> free
//   past_due, within 7 days of period start -> paid (grace)
//   past_due, beyond grace                  -> free
//   canceled / incomplete / paused / no subscription row -> free

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const USER = '11111111-1111-1111-1111-111111111111';

const PLANS = {
  free: { code: 'free', monthly_job_quota: 90, services: ['youtube'], export_stems: false, export_wav24: false },
  pro: { code: 'pro', monthly_job_quota: 100000, services: [], export_stems: true, export_wav24: false },
};

let seq = 0;
// DB stub that answers by SQL text, so the plan lookup follows the plan_code
// the module actually asks for (the old order-based stubs could not tell).
async function load(entRow) {
  const key = `__ent_${++seq}`;
  globalThis[key] = { entRow, planQueries: [] };
  const stub = dataUrl(`
    export const db = { query: async (sql, p) => {
      const s = globalThis[${JSON.stringify(key)}];
      if (/FROM entitlements/.test(sql)) return { rows: s.entRow ? [s.entRow] : [] };
      if (/v_credit_balance/.test(sql)) return { rows: [{ credits_remaining: 0 }] };
      if (/trial_grants/.test(sql)) return { rows: [] };
      if (/FROM plans/.test(sql)) { s.planQueries.push(p[0]); return { rows: [${JSON.stringify(PLANS)}[p[0]]] }; }
      throw new Error('unexpected sql ' + sql);
    } };
  `);
  const js = toJs(readFileSync(join(WEB, 'src/lib/billing/entitlements.ts'), 'utf8'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${stub}'`);
  const mod = await import(dataUrl(js) + '#' + Math.random());
  return { mod, ctx: globalThis[key] };
}

const row = (over = {}) => ({
  plan_code: 'pro',
  period_start: iso(Date.now() - 2 * DAY),
  period_end: iso(Date.now() + 28 * DAY),
  jobs_used: 0,
  sub_status: 'active',
  sub_period_start: iso(Date.now() - 2 * DAY),
  ...over,
});

async function planFor(r) {
  const { mod, ctx } = await load(r);
  const snap = await mod.getEntitlementSnapshot(USER);
  return { snap, ctx };
}

test('active subscription inside its period is Pro', async () => {
  const { snap } = await planFor(row());
  assert.equal(snap.plan_code, 'pro');
  assert.equal(snap.export.stems, true);
});

test('trialing inside its period is Pro', async () => {
  assert.equal((await planFor(row({ sub_status: 'trialing' }))).snap.plan_code, 'pro');
});

test('active but period_end in the past is FREE (and the free plan is what is looked up)', async () => {
  const { snap, ctx } = await planFor(row({ period_end: iso(Date.now() - 1000) }));
  assert.equal(snap.plan_code, 'free');
  assert.equal(snap.export.stems, false);
  assert.deepEqual(ctx.planQueries, ['free']);
});

test('canceled subscription with a still-future period_end is FREE', async () => {
  assert.equal((await planFor(row({ sub_status: 'canceled' }))).snap.plan_code, 'free');
});

test('incomplete (never paid) subscription is FREE', async () => {
  assert.equal((await planFor(row({ sub_status: 'incomplete' }))).snap.plan_code, 'free');
});

test('paused subscription is FREE', async () => {
  assert.equal((await planFor(row({ sub_status: 'paused' }))).snap.plan_code, 'free');
});

test('paid plan with NO subscription row is FREE (fail restrictive)', async () => {
  assert.equal((await planFor(row({ sub_status: null, sub_period_start: null }))).snap.plan_code, 'free');
});

test('past_due within the 7-day grace window stays Pro', async () => {
  const r = row({ sub_status: 'past_due', sub_period_start: iso(Date.now() - 3 * DAY) });
  assert.equal((await planFor(r)).snap.plan_code, 'pro');
});

test('past_due beyond the grace window is FREE even though period_end is a month out', async () => {
  const r = row({
    sub_status: 'past_due',
    sub_period_start: iso(Date.now() - 8 * DAY),
    period_end: iso(Date.now() + 22 * DAY),
  });
  assert.equal((await planFor(r)).snap.plan_code, 'free');
});

test('a free row stays free; no entitlements row at all is free', async () => {
  assert.equal((await planFor(row({ plan_code: 'free', sub_status: null }))).snap.plan_code, 'free');
  assert.equal((await planFor(undefined)).snap.plan_code, 'free');
});

test('the snapshot query joins the subscription status (SQL contract)', async () => {
  const src = readFileSync(join(WEB, 'src/lib/billing/entitlements.ts'), 'utf8');
  assert.match(src, /LEFT JOIN LATERAL[\s\S]*FROM subscriptions/);
});
