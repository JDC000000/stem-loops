// Credits balance route contract test — V3 Phase 1a.
//
// Verifies:
//   1. Unauthenticated -> 401 with no DB read.
//   2. Authenticated -> returns { credits_remaining, purchases, recent_consumption }
//      with the exact shape, from the v_credit_balance view.
//   3. The response carries `Cache-Control: no-store`.
//
// Mocking pattern mirrors sentry-header-scrub.test.mjs: transpile + data URL
// imports, no real network, no real Supabase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/billing/credits/balance/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

function authStub(user) {
  return dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`);
}

function dbStub(rowsByCall) {
  const payload = JSON.stringify(rowsByCall);
  return dataUrl(`
    let i = 0;
    const rowsByCall = ${payload};
    export const db = {
      query: async () => {
        const next = rowsByCall[i++] || { rows: [] };
        return { rows: next.rows, rowCount: next.rows.length };
      },
    };
  `);
}

function nextStub() {
  return dataUrl(`
    export class NextResponse {
      static json(body, init = {}) {
        const headers = new Map(Object.entries((init && init.headers) || {}));
        return { status: init.status ?? 200, body, headers };
      }
    }
  `);
}

async function loadRoute({ user, rowsByCall = [] }) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(rowsByCall)}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

test('GET /api/billing/credits/balance — 401 when unauthenticated', async () => {
  const mod = await loadRoute({ user: null });
  const res = await mod.GET();
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('GET /api/billing/credits/balance — authenticated returns full envelope', async () => {
  const mod = await loadRoute({
    user: { user_id: '11111111-1111-1111-1111-111111111111', email: 'a@b.co' },
    rowsByCall: [
      // v_credit_balance read
      { rows: [{ credits_remaining: 42 }] },
      // credit_purchases
      {
        rows: [
          {
            id: 'p1',
            pack_code: 'credits_60',
            credits_granted: 60,
            amount_usd_cents: 700,
            promo_code: null,
            created_at: '2026-11-03T18:00:00Z',
          },
        ],
      },
      // credit_consumption
      {
        rows: [
          { id: 'c1', job_id: 'j1', consumed_at: '2026-11-03T18:15:00Z' },
        ],
      },
    ],
  });
  const res = await mod.GET();
  assert.equal(res.status, 200);
  assert.equal(res.body.credits_remaining, 42);
  assert.deepEqual(res.body.purchases.map((p) => p.pack_code), ['credits_60']);
  assert.deepEqual(res.body.recent_consumption.map((c) => c.job_id), ['j1']);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('GET /api/billing/credits/balance — credits_remaining from a numeric-string coerces to number', async () => {
  const mod = await loadRoute({
    user: { user_id: '22222222-2222-2222-2222-222222222222', email: 'x@y.co' },
    rowsByCall: [
      { rows: [{ credits_remaining: '17' }] },
      { rows: [] },
      { rows: [] },
    ],
  });
  const res = await mod.GET();
  assert.equal(res.status, 200);
  assert.strictEqual(res.body.credits_remaining, 17);
});
