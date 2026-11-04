// PAID_LINK_INGEST_DISALLOWED (TSD §1.2a / §1.3) — Pro/Studio users may not
// use link-ingest (youtube/spotify/soundcloud); the guard returns a 400.

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
const USER = '11111111-1111-1111-1111-111111111111';

async function load(plan, services) {
  const rows = [
    { rows: [{ plan_code: plan, period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z', jobs_used: 0 }] },
    { rows: [{ credits_remaining: 5 }] },
    { rows: [] },
    { rows: [{ code: plan, monthly_job_quota: 100000, services, export_stems: true, export_wav24: false }] },
  ];
  const stub = dataUrl(`
    // ${Math.random()}
    const rowsByOrder = ${JSON.stringify(rows)};
    export const db = { query: async () => { const b = rowsByOrder.shift() || { rows: [] }; return { rows: b.rows, rowCount: b.rows.length }; } };
  `);
  const js = toJs(readFileSync(join(WEB, 'src/lib/billing/entitlements.ts'), 'utf8')).replace(
    /from ['"]@\/lib\/db['"]/g,
    `from '${stub}'`,
  );
  const mod = await import(dataUrl(js) + '#' + Math.random());
  mod._resetEntitlementCacheForTests();
  return mod;
}

for (const plan of ['pro', 'studio']) {
  for (const action of ['start_job_youtube', 'start_job_spotify', 'start_job_soundcloud']) {
    test(`${plan} + ${action} -> PAID_LINK_INGEST_DISALLOWED (400)`, async () => {
      // Even if the plan row lists the service, paid tiers are upload-only.
      const mod = await load(plan, ['youtube', 'spotify', 'soundcloud']);
      await assert.rejects(
        () => mod.enforceEntitlement(action, USER),
        (err) =>
          err instanceof mod.EntitlementError &&
          err.code === 'PAID_LINK_INGEST_DISALLOWED' &&
          err.status === 400,
      );
    });
  }
}

test('free user link-ingest is still allowed (regression guard)', async () => {
  const mod = await load('free', ['youtube', 'spotify', 'soundcloud']);
  const res = await mod.enforceEntitlement('start_job_youtube', USER);
  assert.equal(res.allowed, true);
});
