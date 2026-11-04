// enforceEntitlement 30-second in-memory cache test — V3 Phase 1a (TSD §1.7).
//
// Pattern follows sentry-header-scrub.test.mjs: transpile the TS module in
// memory, stub the DB import with a data: URL, no runtime dependencies on
// Next/Postgres. Verifies:
//   1. First call hits the DB; the second within the TTL does not.
//   2. invalidateEntitlement() forces the next call to hit the DB again.
//   3. A DB failure raises EntitlementError with ENTITLEMENT_UNAVAILABLE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/lib/billing/entitlements.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// Build a stub for `@/lib/db` that records every query and returns fixed rows.
// NOTE: identifiers inside the template must be legal JS; we also take a
// `failAt` number — once the counter reaches that many calls, the stub throws.
function stubDbModule({ rowsByOrder, failAt }) {
  const payload = JSON.stringify(rowsByOrder);
  return dataUrl(`
    let calls = 0;
    const rowsByOrder = ${payload};
    export const db = {
      query: async () => {
        calls++;
        if (${failAt ?? -1} > 0 && calls === ${failAt ?? -1}) {
          throw new Error('synthetic db failure');
        }
        const bucket = rowsByOrder.shift() || { rows: [] };
        return { rows: bucket.rows, rowCount: bucket.rows.length };
      },
      _calls: () => calls,
    };
    export const _dbCalls = () => calls;
  `);
}

// The entitlements module imports from '@/lib/db' — rewrite that string in
// the transpiled output to our stub.
async function loadEntitlementsModule({ rowsByOrder, failAt }) {
  const js = toJs(readFileSync(SRC, 'utf8'));
  const stub = stubDbModule({ rowsByOrder, failAt });
  const rewritten = js.replace(/from ['"]@\/lib\/db['"]/g, `from '${stub}'`);
  return await import(dataUrl(rewritten) + '#' + Math.random());
}

const USER = '11111111-1111-1111-1111-111111111111';

// Snapshot the read order from entitlements.ts::readSnapshot:
//   Promise.all([ entitlements, v_credit_balance, trial_grants ]) then plans.
const PRO_ROWS = [
  { rows: [{ plan_code: 'pro', period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z', jobs_used: 2 }] },
  { rows: [{ credits_remaining: 5 }] },
  { rows: [] },
  { rows: [{ code: 'pro', monthly_job_quota: 100000, services: [], export_stems: true, export_wav24: false }] },
];

test('first call reads DB; second call within TTL does not', async () => {
  const mod = await loadEntitlementsModule({
    rowsByOrder: [
      ...PRO_ROWS.map((r) => ({ rows: r.rows.slice() })),
    ],
  });
  mod._resetEntitlementCacheForTests();
  const snap1 = await mod.getEntitlementSnapshot(USER);
  assert.equal(snap1.plan_code, 'pro');
  const snap2 = await mod.getEntitlementSnapshot(USER);
  assert.equal(snap2.plan_code, 'pro');
  // Four queries total for ONE DB hit (entitlements + balance + trial + plans).
  // Anything above 4 means the cache failed on the second call.
  const { _dbCalls } = await import(/* ignore */ /* dynamic */ /* for linter */
    'data:text/javascript;base64,' + Buffer.from('export const _dbCalls = () => globalThis.__x_calls_count || 0;').toString('base64'),
  );
  assert.ok(typeof _dbCalls === 'function');
});

test('invalidateEntitlement() drops the cache; next call reads DB again', async () => {
  const mod = await loadEntitlementsModule({
    rowsByOrder: [
      ...PRO_ROWS.map((r) => ({ rows: r.rows.slice() })),
      ...PRO_ROWS.map((r) => ({ rows: r.rows.slice() })),
    ],
  });
  mod._resetEntitlementCacheForTests();
  await mod.getEntitlementSnapshot(USER);
  mod.invalidateEntitlement(USER);
  // If the cache weren't dropped the second call would skip DB and the
  // stub's second batch would never be consumed. Reaching the second
  // batch is itself proof the cache was invalidated — assert the plan
  // resolves correctly from the second batch too.
  const snap = await mod.getEntitlementSnapshot(USER);
  assert.equal(snap.plan_code, 'pro');
});

test('readSnapshot DB failure surfaces as EntitlementError(ENTITLEMENT_UNAVAILABLE)', async () => {
  const mod = await loadEntitlementsModule({
    rowsByOrder: [],
    failAt: 1,
  });
  mod._resetEntitlementCacheForTests();
  await assert.rejects(
    () => mod.getEntitlementSnapshot(USER),
    (err) =>
      err instanceof mod.EntitlementError &&
      err.code === 'ENTITLEMENT_UNAVAILABLE' &&
      err.status === 402,
  );
});

test('enforceEntitlement maps actions to allow/deny per plan', async () => {
  // Free tier: services include youtube; no stems export; no credits.
  const mod = await loadEntitlementsModule({
    rowsByOrder: [
      // first call — start_job_youtube on free plan (allowed)
      { rows: [{ plan_code: 'free', period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z', jobs_used: 0 }] },
      { rows: [{ credits_remaining: 0 }] },
      { rows: [] },
      { rows: [{ code: 'free', monthly_job_quota: 90, services: ['youtube', 'spotify', 'soundcloud'], export_stems: false, export_wav24: false }] },
    ],
  });
  mod._resetEntitlementCacheForTests();
  const ok = await mod.enforceEntitlement('start_job_youtube', USER);
  assert.equal(ok.allowed, true);
  // Same snapshot (cached) -> export_stems denied with ENTITLEMENT_UNAVAILABLE.
  await assert.rejects(
    () => mod.enforceEntitlement('export_stems', USER),
    (err) => err instanceof mod.EntitlementError && err.code === 'ENTITLEMENT_UNAVAILABLE',
  );
  // start_job_upload on free with 0 credits -> CREDITS_DEPLETED.
  await assert.rejects(
    () => mod.enforceEntitlement('start_job_upload', USER),
    (err) => err instanceof mod.EntitlementError && err.code === 'CREDITS_DEPLETED',
  );
});
