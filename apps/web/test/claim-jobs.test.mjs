// /api/users/me/claim-jobs contract test — V3 Phase 1a (TSD §2.2, V3-U2).
//
// Mirrors the mocking strategy in billing-credits-balance.test.mjs: transpile
// the route in-memory, replace the @/lib/auth/supabase, @/lib/db, and
// next/server imports with data-URL stubs. No real network, no real DB.
//
// Covers:
//   1. 401 when unauthenticated — no DB reads.
//   2. 400 when client_fingerprint is missing or too short.
//   3. Happy path — returns claimed_count == rowCount of the final UPDATE,
//      and records a usage_events row BEFORE the UPDATE (so even a 0-match
//      claim counts toward the rate limit).
//   4. Zero ip-hash cohort — short-circuits to 0 without an UPDATE.
//   5. Rate limited — returns 429 when prior usage_events count >= 1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/users/me/claim-jobs/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

function authStub(user) {
  return dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`);
}

// db stub: records every query call for later inspection, and lets the
// test script the result of each successive query inside tx().
function dbStub(scriptedTxResults) {
  const payload = JSON.stringify(scriptedTxResults);
  return dataUrl(`
    globalThis.__claimJobsCalls = [];
    const scripted = ${payload};
    let i = 0;
    const client = {
      query: async (text, params) => {
        globalThis.__claimJobsCalls.push({ text, params });
        const next = scripted[i++] || { rows: [], rowCount: 0 };
        return { rows: next.rows ?? [], rowCount: next.rowCount ?? (next.rows ? next.rows.length : 0) };
      },
    };
    export const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
      tx: async (fn) => await fn(client),
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

async function loadRoute({ user, scriptedTxResults = [] }) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(scriptedTxResults)}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

function makeReq(body) {
  return {
    json: async () => body,
  };
}

test('POST /api/users/me/claim-jobs — 401 when unauthenticated', async () => {
  const mod = await loadRoute({ user: null });
  const res = await mod.POST(makeReq({ client_fingerprint: 'abcd1234abcd1234' }));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
  // No DB calls on the unauth path.
  assert.equal((globalThis.__claimJobsCalls ?? []).length, 0);
});

test('POST /api/users/me/claim-jobs — 400 when client_fingerprint missing', async () => {
  const mod = await loadRoute({
    user: { user_id: '11111111-1111-1111-1111-111111111111', email: 'a@b.co' },
  });
  const res = await mod.POST(makeReq({}));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CLAIM_JOBS_INVALID');
});

test('POST /api/users/me/claim-jobs — 400 when client_fingerprint too short', async () => {
  const mod = await loadRoute({
    user: { user_id: '11111111-1111-1111-1111-111111111111', email: 'a@b.co' },
  });
  const res = await mod.POST(makeReq({ client_fingerprint: 'short' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CLAIM_JOBS_INVALID');
});

test('POST /api/users/me/claim-jobs — happy path claims N jobs', async () => {
  const mod = await loadRoute({
    user: { user_id: '22222222-2222-2222-2222-222222222222', email: 'x@y.co' },
    scriptedTxResults: [
      // 1. advisory lock
      { rows: [{}] },
      // 2. rate-limit count — 0
      { rows: [{ n: '0' }] },
      // 3. ip-hash cohort — two hashes
      { rows: [{ client_ip_hash: 'h1' }, { client_ip_hash: 'h2' }] },
      // 4. usage_events insert
      { rows: [], rowCount: 1 },
      // 5. UPDATE jobs ... RETURNING id — three rows
      { rows: [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }], rowCount: 3 },
    ],
  });
  const res = await mod.POST(makeReq({ client_fingerprint: 'fp_abcd1234abcd1234' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.claimed_count, 3);
  const calls = globalThis.__claimJobsCalls;
  // usage_events INSERT must come BEFORE the UPDATE (gate on the rate-
  // limit count even on a zero-match claim).
  const insertIdx = calls.findIndex((c) => /INSERT INTO public\.usage_events/i.test(c.text));
  const updateIdx = calls.findIndex((c) => /^\s*UPDATE public\.jobs/i.test(c.text));
  assert.ok(insertIdx !== -1, 'usage_events INSERT should be called');
  assert.ok(updateIdx !== -1, 'jobs UPDATE should be called');
  assert.ok(insertIdx < updateIdx, 'INSERT must precede UPDATE');
  // The UPDATE filters by user_id IS NULL (idempotency guard).
  assert.match(calls[updateIdx].text, /user_id IS NULL/);
});

test('POST /api/users/me/claim-jobs — zero ip-hash cohort returns claimed_count=0 without UPDATE', async () => {
  const mod = await loadRoute({
    user: { user_id: '33333333-3333-3333-3333-333333333333', email: 'z@q.co' },
    scriptedTxResults: [
      // advisory lock
      { rows: [{}] },
      // rate-limit count
      { rows: [{ n: '0' }] },
      // ip-hash cohort empty
      { rows: [] },
      // usage_events insert (still recorded so attempts are counted)
      { rows: [], rowCount: 1 },
    ],
  });
  const res = await mod.POST(makeReq({ client_fingerprint: 'fp_abcd1234abcd1234' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.claimed_count, 0);
  const calls = globalThis.__claimJobsCalls;
  const updateCall = calls.find((c) => /^\s*UPDATE public\.jobs/i.test(c.text));
  assert.equal(updateCall, undefined, 'UPDATE must not fire for empty cohort');
});

test('POST /api/users/me/claim-jobs — second call inside window returns 429', async () => {
  const mod = await loadRoute({
    user: { user_id: '44444444-4444-4444-4444-444444444444', email: 'q@q.co' },
    scriptedTxResults: [
      // advisory lock
      { rows: [{}] },
      // rate-limit count — already at cap
      { rows: [{ n: '1' }] },
    ],
  });
  const res = await mod.POST(makeReq({ client_fingerprint: 'fp_abcd1234abcd1234' }));
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'RATE_LIMITED');
  const calls = globalThis.__claimJobsCalls;
  const updateCall = calls.find((c) => /^\s*UPDATE public\.jobs/i.test(c.text));
  const insertCall = calls.find((c) => /INSERT INTO public\.usage_events/i.test(c.text));
  assert.equal(updateCall, undefined, 'UPDATE must not fire when rate-limited');
  assert.equal(insertCall, undefined, 'usage_events INSERT must not fire when rate-limited');
});
