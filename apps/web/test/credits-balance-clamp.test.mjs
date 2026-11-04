// Credits balance clamp test — review M6.
//
// A DB without migration 022 can return a negative v_credit_balance. The route
// must clamp to 0 so the UI never shows "-5 credits".
//
// Mocking pattern mirrors billing-credits-balance.test.mjs: transpile + data
// URL imports, no real network, no real Supabase.

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

const authStub = (user) =>
  dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`);

function dbStub(rowsByCall) {
  return dataUrl(`
    let i = 0;
    const rowsByCall = ${JSON.stringify(rowsByCall)};
    export const db = {
      query: async () => {
        const next = rowsByCall[i++] || { rows: [] };
        return { rows: next.rows, rowCount: next.rows.length };
      },
    };
  `);
}

const nextStub = () =>
  dataUrl(`
    export class NextResponse {
      static json(body, init = {}) {
        const headers = new Map(Object.entries((init && init.headers) || {}));
        return { status: init.status ?? 200, body, headers };
      }
    }
  `);

async function loadRoute({ user, rowsByCall }) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(rowsByCall)}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

const USER = { user_id: '33333333-3333-3333-3333-333333333333', email: 'n@g.co' };

test('balance route — DB balance -5 (number) -> credits_remaining 0', async () => {
  const mod = await loadRoute({
    user: USER,
    rowsByCall: [{ rows: [{ credits_remaining: -5 }] }, { rows: [] }, { rows: [] }],
  });
  const res = await mod.GET();
  assert.equal(res.status, 200);
  assert.strictEqual(res.body.credits_remaining, 0);
});

test('balance route — DB balance "-5" (bigint string) -> credits_remaining 0', async () => {
  const mod = await loadRoute({
    user: USER,
    rowsByCall: [{ rows: [{ credits_remaining: '-5' }] }, { rows: [] }, { rows: [] }],
  });
  const res = await mod.GET();
  assert.strictEqual(res.body.credits_remaining, 0);
});

test('balance route — positive balance unchanged', async () => {
  const mod = await loadRoute({
    user: USER,
    rowsByCall: [{ rows: [{ credits_remaining: 7 }] }, { rows: [] }, { rows: [] }],
  });
  const res = await mod.GET();
  assert.strictEqual(res.body.credits_remaining, 7);
});
