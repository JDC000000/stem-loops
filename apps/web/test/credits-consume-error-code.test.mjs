// Credit consume error-code + SQL-shape tests — credit-ledger review B1/M3/M8.
//
//   1. enforceEntitlement('start_job_upload') on a zero-credit free user
//      throws CREDIT_BALANCE_INSUFFICIENT (TSD §1.3), NOT the old
//      CREDITS_DEPLETED, and error-copy has an entry for the new code.
//   2. consumeCreditInTx takes the advisory lock, runs the conditional
//      INSERT, and throws CREDIT_BALANCE_INSUFFICIENT on rowCount === 0.
//   3. Nothing in src/ still references CREDITS_DEPLETED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
const JOB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function dbStub(rows) {
  return dataUrl(`
    const rowsByOrder = ${JSON.stringify(rows)};
    export const db = {
      query: async () => {
        const b = rowsByOrder.shift() || { rows: [] };
        return { rows: b.rows, rowCount: b.rows.length };
      },
      tx: async (fn) => fn({ query: async (...a) => db.query(...a) }),
    };
  `);
}

async function loadEntitlements(rows) {
  const js = toJs(readFileSync(join(WEB, 'src/lib/billing/entitlements.ts'), 'utf8')).replace(
    /from ['"]@\/lib\/db['"]/g,
    `from '${dbStub(rows)}'`,
  );
  return import(dataUrl(js) + '#' + Math.random());
}

// credits.ts wired to the real EntitlementError class from entitlements.ts.
async function loadCredits() {
  const ent = await loadEntitlements([]);
  globalThis.__EntitlementError = ent.EntitlementError;
  const entStub = dataUrl(`export const EntitlementError = globalThis.__EntitlementError;`);
  const js = toJs(readFileSync(join(WEB, 'src/lib/billing/credits.ts'), 'utf8')).replace(
    /from ['"]@\/lib\/billing\/entitlements['"]/g,
    `from '${entStub}'`,
  );
  return { credits: await import(dataUrl(js) + '#' + Math.random()), ent };
}

test('zero-credit free upload -> CREDIT_BALANCE_INSUFFICIENT (not CREDITS_DEPLETED)', async () => {
  const mod = await loadEntitlements([
    { rows: [{ plan_code: 'free', period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z', jobs_used: 0 }] },
    { rows: [{ credits_remaining: 0 }] },
    { rows: [] },
    { rows: [{ code: 'free', monthly_job_quota: 90, services: ['youtube'], export_stems: false, export_wav24: false }] },
  ]);
  mod._resetEntitlementCacheForTests();
  await assert.rejects(
    () => mod.enforceEntitlement('start_job_upload', USER),
    (err) =>
      err instanceof mod.EntitlementError &&
      err.code === 'CREDIT_BALANCE_INSUFFICIENT' &&
      err.errorCopyKey === 'CREDIT_BALANCE_INSUFFICIENT' &&
      err.status === 402,
  );
});

test('error-copy carries CREDIT_BALANCE_INSUFFICIENT and no CREDITS_DEPLETED', async () => {
  const js = toJs(readFileSync(join(WEB, 'src/lib/error-copy.ts'), 'utf8'));
  const mod = await import(dataUrl(js) + '#' + Math.random());
  assert.ok(mod.ERROR_COPY.CREDIT_BALANCE_INSUFFICIENT?.headline);
  assert.equal(mod.ERROR_COPY.CREDITS_DEPLETED, undefined);
  assert.ok(mod.ERROR_COPY.PAID_LINK_INGEST_DISALLOWED?.headline);
});

test('consumeCreditInTx: advisory lock then conditional INSERT; throws on rowCount 0', async () => {
  const { credits, ent } = await loadCredits();
  const seen = [];
  const mk = (insertRows) => ({
    query: async (text, params) => {
      seen.push({ text, params });
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}], rowCount: 1 };
      return { rows: insertRows, rowCount: insertRows.length };
    },
  });

  await credits.consumeCreditInTx(mk([{ id: 'c1' }]), USER, JOB);
  assert.match(seen[0].text, /pg_advisory_xact_lock/);
  assert.deepEqual(seen[0].params, ['credit_consume', USER]);
  assert.match(seen[1].text, /INSERT INTO credit_consumption/);
  assert.match(seen[1].text, /v_credit_balance/);
  assert.match(seen[1].text, /> 0/);
  assert.match(seen[1].text, /RETURNING id/);
  assert.deepEqual(seen[1].params, [USER, JOB]);

  await assert.rejects(
    () => credits.consumeCreditInTx(mk([]), USER, JOB),
    (err) => err instanceof ent.EntitlementError && err.code === 'CREDIT_BALANCE_INSUFFICIENT',
  );
});

test('no CREDITS_DEPLETED references remain in web src/', () => {
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(f) && readFileSync(p, 'utf8').includes('CREDITS_DEPLETED')) hits.push(p);
    }
  };
  walk(join(WEB, 'src'));
  assert.deepEqual(hits, []);
});
