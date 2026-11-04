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
//      claim counts toward the rate limit). truncated=false.
//   4. Zero ip-hash cohort — short-circuits to 0 without an UPDATE,
//      truncated=false.
//   5. Rate limited — returns 429 when prior usage_events count >= 1.
//   6. Truncated path — when the UPDATE hits MAX_CLAIMED_JOBS and the
//      follow-up COUNT finds remaining eligible rows, the response has
//      truncated=true and a usage_events row with kind='claim_jobs_truncated'
//      is written. We override MAX_CLAIMED_JOBS to 3 in-fixture via an
//      eval-time source rewrite so the test does not have to seed 5001 rows.
//   7. Ceiling-hit without remainder — rowCount == MAX but the COUNT
//      query returns 0, so truncated=false and NO claim_jobs_truncated
//      row is written (exact-fit boundary).

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

async function loadRoute({ user, scriptedTxResults = [], maxClaimedJobs }) {
  let src = readFileSync(SRC, 'utf8');
  if (typeof maxClaimedJobs === 'number') {
    // Rewrite the compile-time MAX_CLAIMED_JOBS constant so a truncation
    // test can hit the ceiling without seeding thousands of rows.
    const re = /const\s+MAX_CLAIMED_JOBS\s*=\s*\d+\s*;/;
    assert.ok(re.test(src), 'MAX_CLAIMED_JOBS constant must be present in route.ts');
    src = src.replace(re, `const MAX_CLAIMED_JOBS = ${maxClaimedJobs};`);
  }
  let js = toJs(src);
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
  assert.equal(res.body.truncated, false, 'happy path must set truncated=false');
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
  // Non-ceiling rowCount must NOT trigger the remaining-count probe.
  const truncInsert = calls.find((c) =>
    /INSERT INTO public\.usage_events/i.test(c.text) && /claim_jobs_truncated/i.test(String(c.params?.[1] ?? '')),
  );
  assert.equal(truncInsert, undefined, 'no truncation event on happy path');
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
  assert.equal(res.body.truncated, false, 'empty cohort must set truncated=false');
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

test('POST /api/users/me/claim-jobs — truncation: UPDATE hits MAX and remaining>0 sets truncated=true + logs claim_jobs_truncated', async () => {
  // Rewrite MAX_CLAIMED_JOBS to 3 for this test so we can hit the ceiling
  // with a scripted 3-row UPDATE (equivalent to seeding 5001+ rows in a
  // real DB test against the default 5000 cap).
  const mod = await loadRoute({
    user: { user_id: '55555555-5555-5555-5555-555555555555', email: 't@t.co' },
    maxClaimedJobs: 3,
    scriptedTxResults: [
      // 1. advisory lock
      { rows: [{}] },
      // 2. rate-limit count — 0
      { rows: [{ n: '0' }] },
      // 3. ip-hash cohort — one hash
      { rows: [{ client_ip_hash: 'h1' }] },
      // 4. usage_events claim_jobs insert
      { rows: [], rowCount: 1 },
      // 5. UPDATE jobs ... RETURNING id — three rows (== MAX_CLAIMED_JOBS)
      { rows: [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }], rowCount: 3 },
      // 6. SELECT COUNT remaining — 2 rows still eligible
      { rows: [{ n: '2' }] },
      // 7. usage_events claim_jobs_truncated insert
      { rows: [], rowCount: 1 },
    ],
  });
  const res = await mod.POST(makeReq({ client_fingerprint: 'fp_abcd1234abcd1234' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.claimed_count, 3);
  assert.equal(res.body.truncated, true, 'truncation path must set truncated=true');
  const calls = globalThis.__claimJobsCalls;
  // The truncation-COUNT probe must be the first query after the UPDATE.
  const updateIdx = calls.findIndex((c) => /^\s*UPDATE public\.jobs/i.test(c.text));
  const countIdx = calls.findIndex(
    (c, i) => i > updateIdx && /SELECT COUNT\(\*\)/i.test(c.text) && /user_id IS NULL/.test(c.text),
  );
  assert.ok(countIdx !== -1, 'remaining-count probe must run when UPDATE hits MAX');
  // A second usage_events INSERT with kind='claim_jobs_truncated' must be
  // written, and its detail JSON must carry the TOTAL matched count
  // (claimed + remaining).
  const truncInsert = calls.find(
    (c) =>
      /INSERT INTO public\.usage_events/i.test(c.text) &&
      /claim_jobs_truncated/.test(c.text),
  );
  assert.ok(truncInsert, 'claim_jobs_truncated row must be inserted');
  const detail = JSON.parse(truncInsert.params[1]);
  assert.equal(detail.count, 5, 'detail.count should be claimed + remaining (3+2)');
});

test('POST /api/users/me/claim-jobs — ceiling without remainder: truncated=false, no claim_jobs_truncated row', async () => {
  // rowCount == MAX but no further eligible rows: boundary case where
  // the UPDATE happened to drain the cohort exactly.
  const mod = await loadRoute({
    user: { user_id: '66666666-6666-6666-6666-666666666666', email: 'b@b.co' },
    maxClaimedJobs: 3,
    scriptedTxResults: [
      { rows: [{}] },
      { rows: [{ n: '0' }] },
      { rows: [{ client_ip_hash: 'h1' }] },
      { rows: [], rowCount: 1 },
      // UPDATE — exactly 3 rows
      { rows: [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }], rowCount: 3 },
      // COUNT remaining — 0
      { rows: [{ n: '0' }] },
    ],
  });
  const res = await mod.POST(makeReq({ client_fingerprint: 'fp_abcd1234abcd1234' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.claimed_count, 3);
  assert.equal(res.body.truncated, false, 'exact-fit must set truncated=false');
  const calls = globalThis.__claimJobsCalls;
  const truncInsert = calls.find(
    (c) =>
      /INSERT INTO public\.usage_events/i.test(c.text) && /claim_jobs_truncated/.test(c.text),
  );
  assert.equal(truncInsert, undefined, 'no truncation row on exact-fit ceiling');
});
