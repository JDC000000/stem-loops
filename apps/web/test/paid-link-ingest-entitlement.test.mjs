// enforceEntitlement('start_job_<link>') for Pro / Studio after TSD-V3-DELTA
// §1.2a was REVERSED by Jon on 2026-11-16. (This file used to be
// paid-link-ingest-disallowed.test.mjs and asserted the opposite.)
//
// The rule now:
//   • a paid plan may ingest a link iff ITS plans.services row lists the
//     service (migration 039 writes ['youtube'] on pro/studio) — data-driven,
//     so deploy-before-migrate refuses instead of granting;
//   • and only while jobs_used < jobs_quota — the start_job_upload predicate;
//   • PAID_LINK_INGEST_DISALLOWED is never thrown.

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
const QUOTA = { free: 5, pro: 50, studio: 150 };

async function load(plan, services, { jobsUsed = 0, quota = QUOTA[plan], credits = 0, trial = null } = {}) {
  const future = new Date(Date.now() + 7 * 864e5).toISOString();
  const rows = [
    { rows: [{ plan_code: plan, period_start: '2026-11-01T00:00:00Z', period_end: future, jobs_used: jobsUsed, sub_status: plan === 'free' ? null : 'active', sub_period_start: '2026-11-01T00:00:00Z' }] },
    { rows: [{ credits_remaining: credits }] },
    { rows: trial ? [trial] : [] },
    { rows: [{ code: plan, monthly_job_quota: quota, services, export_stems: false, export_wav24: false }] },
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

const refusedWith = (mod, detail) => (err) =>
  err instanceof mod.EntitlementError &&
  err.code === 'ENTITLEMENT_UNAVAILABLE' &&
  err.message === detail &&
  err.status === 402;

for (const plan of ['pro', 'studio']) {
  test(`${plan} + start_job_youtube, row lists youtube (039 applied), under quota -> allowed`, async () => {
    const mod = await load(plan, ['youtube'], { jobsUsed: QUOTA[plan] - 1 });
    const res = await mod.enforceEntitlement('start_job_youtube', USER);
    assert.equal(res.allowed, true);
    assert.equal(res.snapshot.plan_code, plan);
    assert.equal(res.snapshot.jobs_quota, QUOTA[plan]);
  });

  test(`${plan} + start_job_youtube, quota spent -> ENTITLEMENT_UNAVAILABLE 'quota exhausted' (the upload refusal)`, async () => {
    const mod = await load(plan, ['youtube'], { jobsUsed: QUOTA[plan] });
    await assert.rejects(() => mod.enforceEntitlement('start_job_youtube', USER), refusedWith(mod, 'quota exhausted'));
  });

  test(`${plan}: link and upload gates agree at the quota boundary`, async () => {
    for (const jobsUsed of [0, QUOTA[plan] - 1, QUOTA[plan], QUOTA[plan] + 3]) {
      const outcome = async (action) => {
        const mod = await load(plan, ['youtube'], { jobsUsed });
        try { await mod.enforceEntitlement(action, USER); return 'allowed'; } catch (e) { return `${e.code}:${e.message}`; }
      };
      assert.equal(await outcome('start_job_youtube'), await outcome('start_job_upload'), `jobs_used=${jobsUsed}`);
    }
  });

  test(`${plan} + start_job_youtube, row still [] (039 NOT applied) -> refused 'service not in plan', not granted`, async () => {
    const mod = await load(plan, []);
    await assert.rejects(() => mod.enforceEntitlement('start_job_youtube', USER), refusedWith(mod, 'service not in plan'));
  });

  test(`${plan}: a trial grant never opens the link path when the row lacks the service`, async () => {
    const mod = await load(plan, [], { trial: { songs_used: 0, expires_at: '2099-01-01T00:00:00Z' } });
    await assert.rejects(() => mod.enforceEntitlement('start_job_youtube', USER), refusedWith(mod, 'service not in plan'));
  });

  for (const action of ['start_job_spotify', 'start_job_soundcloud']) {
    test(`${plan} + ${action} (unbuilt, not in the row) -> refused 'service not in plan'`, async () => {
      const mod = await load(plan, ['youtube']);
      await assert.rejects(() => mod.enforceEntitlement(action, USER), refusedWith(mod, 'service not in plan'));
    });
  }

  test(`${plan}: PAID_LINK_INGEST_DISALLOWED is never thrown`, async () => {
    for (const services of [[], ['youtube'], ['youtube', 'spotify', 'soundcloud']]) {
      for (const jobsUsed of [0, 10_000]) {
        for (const action of ['start_job_youtube', 'start_job_spotify', 'start_job_soundcloud']) {
          const mod = await load(plan, services, { jobsUsed });
          try {
            await mod.enforceEntitlement(action, USER);
          } catch (err) {
            assert.notEqual(err.code, 'PAID_LINK_INGEST_DISALLOWED', `${action} ${JSON.stringify(services)} ${jobsUsed}`);
          }
        }
      }
    }
  });
}

test('free user link-ingest unchanged: allowed whatever jobs_used says (the route meters it)', async () => {
  for (const jobsUsed of [0, 5, 50]) {
    const mod = await load('free', ['youtube'], { jobsUsed });
    const res = await mod.enforceEntitlement('start_job_youtube', USER);
    assert.equal(res.allowed, true);
  }
});

test('the legacy code keeps its 400 so an old stored error_code still resolves', async () => {
  const mod = await load('free', ['youtube']);
  assert.equal(new mod.EntitlementError('PAID_LINK_INGEST_DISALLOWED').status, 400);
});

test('source: the plan-code refusal is gone from entitlements.ts', () => {
  const src = readFileSync(join(WEB, 'src/lib/billing/entitlements.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /new EntitlementError\('PAID_LINK_INGEST_DISALLOWED'/);
});
