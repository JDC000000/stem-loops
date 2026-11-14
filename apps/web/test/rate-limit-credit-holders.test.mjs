// checkMonthlyQuota credit-holder short-circuit — review M1.
//
// A free-plan user with credits_remaining > 0 must not be blocked by the
// free 90-jobs/mo quota. Pro/Studio (unlimited sentinel) are unaffected.
// Pattern mirrors billing-credits-balance.test.mjs: transpile + data URLs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/lib/billing/rate-limit.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const PERIOD_END = new Date(Date.now() + 15 * 86_400_000).toISOString();

async function loadCheck(snap) {
  const entStub = dataUrl(
    `export const getEntitlementSnapshot = async () => (${JSON.stringify(snap)});\n` +
      // checkMonthlyQuota() now shares its stale-period predicate with
      // enforceEntitlement() instead of inlining it, so the stub has to
      // provide it. Same semantics as the inline check it replaced.
      `export const isPeriodStale = (pe, now = Date.now()) =>
         pe !== null && Number.isFinite(Date.parse(pe)) && Date.parse(pe) <= now;`,
  );
  const dbStub = dataUrl(`export const db = { tx: async () => { throw new Error('unused'); } };`);
  const js = toJs(readFileSync(SRC, 'utf8'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]\.\/entitlements['"]/g, `from '${entStub}'`);
  return (await import(dataUrl(js))).checkMonthlyQuota;
}

const snap = (o) => ({
  plan_code: 'free',
  period_start: null,
  period_end: PERIOD_END,
  jobs_used: 0,
  jobs_quota: 90,
  services: [],
  export: { stems: false, wav24: false },
  credits_remaining: 0,
  trial_songs_remaining: null,
  ...o,
});

test('free + 0 credits + 90 used -> blocked', async () => {
  const check = await loadCheck(snap({ credits_remaining: 0, jobs_used: 90 }));
  const r = await check('u1');
  assert.equal(r?.kind, 'quota_exceeded');
  assert.equal(r.resets_at, PERIOD_END);
});

test('free + 20 credits + 90 used -> allowed', async () => {
  const check = await loadCheck(snap({ credits_remaining: 20, jobs_used: 90 }));
  assert.equal(await check('u1'), null);
});

test('free + 0 credits + 89 used -> allowed', async () => {
  const check = await loadCheck(snap({ credits_remaining: 0, jobs_used: 89 }));
  assert.equal(await check('u1'), null);
});

test('free + 1 credit + 1000 used -> allowed', async () => {
  const check = await loadCheck(snap({ credits_remaining: 1, jobs_used: 1000 }));
  assert.equal(await check('u1'), null);
});

test('pro + 0 credits + 99999 used -> allowed (unlimited)', async () => {
  const check = await loadCheck(
    snap({ plan_code: 'pro', jobs_quota: 100000, credits_remaining: 0, jobs_used: 99999 }),
  );
  assert.equal(await check('u1'), null);
});
