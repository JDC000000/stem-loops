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
// Round-2 fix: export a real `dbCalls()` getter driven by a SHARED counter
// stashed on globalThis under a unique key per module load. The previous
// version exposed only an `_dbCalls` symbol that re-read globalThis.<x>
// (which the stub never populated), so `typeof _dbCalls === 'function'`
// was the only thing the test could assert. Now the test can read the
// counter directly and assert exact DB-call counts (one 4-query snapshot
// per cache miss, 0 queries on a cache hit).
function stubDbModule({ rowsByOrder, failAt, counterKey }) {
  const payload = JSON.stringify(rowsByOrder);
  return dataUrl(`
    const CK = ${JSON.stringify(counterKey)};
    globalThis[CK] = 0;
    const rowsByOrder = ${payload};
    export const db = {
      query: async () => {
        globalThis[CK] = (globalThis[CK] || 0) + 1;
        if (${failAt ?? -1} > 0 && globalThis[CK] === ${failAt ?? -1}) {
          throw new Error('synthetic db failure');
        }
        const bucket = rowsByOrder.shift() || { rows: [] };
        return { rows: bucket.rows, rowCount: bucket.rows.length };
      },
      tx: async (fn) => fn({
        query: async (...args) => db.query(...args),
      }),
    };
    export const dbCalls = () => globalThis[CK] || 0;
  `);
}

// Per-load unique counter key — multiple module loads in one test file must
// not share a counter or the cache assertions become flaky.
let _counterSeq = 0;

// The entitlements module imports from '@/lib/db' — rewrite that string in
// the transpiled output to our stub. Returns the module AND the dbCalls
// getter wired to the same counter.
async function loadEntitlementsModule({ rowsByOrder, failAt }) {
  const js = toJs(readFileSync(SRC, 'utf8'));
  const counterKey = `__stub_db_calls_${++_counterSeq}`;
  const stub = stubDbModule({ rowsByOrder, failAt, counterKey });
  const rewritten = js.replace(/from ['"]@\/lib\/db['"]/g, `from '${stub}'`);
  const mod = await import(dataUrl(rewritten) + '#' + Math.random());
  return { mod, dbCalls: () => globalThis[counterKey] || 0 };
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

test('first call reads DB (4 queries); second call within TTL does NOT hit DB', async () => {
  const { mod, dbCalls } = await loadEntitlementsModule({
    rowsByOrder: [
      ...PRO_ROWS.map((r) => ({ rows: r.rows.slice() })),
    ],
  });
  mod._resetEntitlementCacheForTests();
  assert.equal(dbCalls(), 0, 'no queries before first snapshot');

  const snap1 = await mod.getEntitlementSnapshot(USER);
  assert.equal(snap1.plan_code, 'pro');
  const afterFirst = dbCalls();
  // readSnapshot does entitlements + v_credit_balance + trial_grants in
  // parallel, then plans separately == 4 queries per cache miss.
  assert.equal(
    afterFirst,
    4,
    `expected 4 DB queries for one snapshot read, got ${afterFirst}`,
  );

  const snap2 = await mod.getEntitlementSnapshot(USER);
  assert.equal(snap2.plan_code, 'pro');
  const afterSecond = dbCalls();
  // Cache MUST have served the second call — zero additional DB queries.
  assert.equal(
    afterSecond,
    4,
    `cache failed: expected still 4 DB queries after second snapshot (cache hit), got ${afterSecond}`,
  );
});

test('invalidateEntitlement() drops the cache; next call re-reads DB (4 more queries)', async () => {
  const { mod, dbCalls } = await loadEntitlementsModule({
    rowsByOrder: [
      ...PRO_ROWS.map((r) => ({ rows: r.rows.slice() })),
      ...PRO_ROWS.map((r) => ({ rows: r.rows.slice() })),
    ],
  });
  mod._resetEntitlementCacheForTests();
  await mod.getEntitlementSnapshot(USER);
  assert.equal(dbCalls(), 4, 'first snapshot hits DB 4 times');
  mod.invalidateEntitlement(USER);
  const snap = await mod.getEntitlementSnapshot(USER);
  assert.equal(snap.plan_code, 'pro');
  // After invalidation the second snapshot re-reads: 4 + 4 = 8 total.
  assert.equal(
    dbCalls(),
    8,
    'invalidateEntitlement must force a fresh DB read on the next snapshot',
  );
});

test('readSnapshot DB failure surfaces as EntitlementError(ENTITLEMENT_UNAVAILABLE)', async () => {
  const { mod } = await loadEntitlementsModule({
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
  const { mod } = await loadEntitlementsModule({
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
