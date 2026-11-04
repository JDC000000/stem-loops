// /api/users/me/trial contract tests — V3 Phase 1a (TSD §1.6, V3-C10).
//
// Mirrors the mocking approach in claim-jobs.test.mjs and
// billing-credits-balance.test.mjs: transpile the route in-memory,
// replace @/lib/auth/supabase, @/lib/trial, and next/server with data-URL
// stubs. No real network, no real DB.
//
// Covered here:
//   grant:
//     1. 401 when unauthenticated — no trial call.
//     2. 200 fresh-grant path — returns granted:true + songs_remaining:3.
//     3. 200 idempotent path — returns granted:false and the existing state.
//     4. 503 when the trial helper throws (DB down).
//   consume:
//     5. 401 when unauthenticated — no consume call.
//     6. 200 ok:true — returns new songs_remaining + expires_at.
//     7. 200 ok:false reasons — no_grant / expired / exhausted pass through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRANT_SRC = join(WEB, 'src/app/api/users/me/trial/grant/route.ts');
const CONSUME_SRC = join(WEB, 'src/app/api/users/me/trial/consume/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

function authStub(user) {
  return dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`);
}

// Trial lib stub: scripts the return value (or throws) for the one helper
// each route uses. Records calls for assertions.
function trialStub({ grantResult, consumeResult, throwOnGrant, throwOnConsume }) {
  const payload = JSON.stringify({ grantResult, consumeResult, throwOnGrant, throwOnConsume });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__trialCalls = { grant: 0, consume: 0 };
    export const TRIAL_SONG_CAP = 3;
    export const grantTrial = async (userId) => {
      globalThis.__trialCalls.grant++;
      globalThis.__trialLastUser = userId;
      if (cfg.throwOnGrant) throw new Error('db down');
      return cfg.grantResult;
    };
    export const consumeTrial = async (userId) => {
      globalThis.__trialCalls.consume++;
      globalThis.__trialLastUser = userId;
      if (cfg.throwOnConsume) throw new Error('db down');
      return cfg.consumeResult;
    };
    export const readTrial = async () => ({ present: false });
  `);
}

function nextStub() {
  return dataUrl(`
    export class NextResponse {
      constructor(rawBody, init = {}) {
        this.status = (init && init.status) ?? 200;
        this.headers = new Map(Object.entries((init && init.headers) || {}));
        try { this.body = JSON.parse(rawBody); } catch { this.body = rawBody; }
      }
      static json(body, init = {}) {
        const headers = new Map(Object.entries((init && init.headers) || {}));
        return { status: init.status ?? 200, body, headers };
      }
    }
  `);
}

async function loadGrantRoute({ user, trial }) {
  globalThis.__trialCalls = { grant: 0, consume: 0 };
  globalThis.__trialLastUser = undefined;
  let js = toJs(readFileSync(GRANT_SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${trialStub(trial ?? {})}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

// Burst-limit stub for /api/users/me/trial/consume (round-2 FIX #3).
// `limited` = true → returns a BurstDenial, false → returns null and the
// route proceeds. Records calls so tests can assert the gate ran.
function burstStub({ limited = false } = {}) {
  const payload = JSON.stringify({ limited });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__burstCalls = 0;
    export const checkBurstLimit = async (userId) => {
      globalThis.__burstCalls++;
      globalThis.__burstLastUser = userId;
      if (cfg.limited) return { kind: 'rate_limit_burst', retry_after_s: 60 };
      return null;
    };
  `);
}

async function loadConsumeRoute({ user, trial, burst } = {}) {
  // Reset shared globalThis counters: stub data URLs with identical payloads
  // are module-cached by the runtime, so their top-level init lines won't
  // re-run on reload. Explicit reset per test keeps call counts accurate.
  globalThis.__trialCalls = { grant: 0, consume: 0 };
  globalThis.__trialLastUser = undefined;
  globalThis.__burstCalls = 0;
  globalThis.__burstLastUser = undefined;
  let js = toJs(readFileSync(CONSUME_SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${trialStub(trial ?? {})}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${burstStub(burst ?? {})}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

const USER = { user_id: '11111111-1111-1111-1111-111111111111', email: 'u@x.co' };
const EXPIRY = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

// --- GRANT ---------------------------------------------------------------

test('POST /api/users/me/trial/grant — 401 when unauthenticated', async () => {
  const mod = await loadGrantRoute({
    user: null,
    trial: { grantResult: { granted: true, songs_remaining: 3, expires_at: EXPIRY, expired: false } },
  });
  const res = await mod.POST();
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
  assert.equal(globalThis.__trialCalls.grant, 0, 'grantTrial must not be called on 401');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('POST /api/users/me/trial/grant — fresh grant returns granted:true', async () => {
  const mod = await loadGrantRoute({
    user: USER,
    trial: { grantResult: { granted: true, songs_remaining: 3, expires_at: EXPIRY, expired: false } },
  });
  const res = await mod.POST();
  assert.equal(res.status, 200);
  assert.equal(res.body.granted, true);
  assert.equal(res.body.songs_remaining, 3);
  assert.equal(res.body.expires_at, EXPIRY);
  assert.equal(res.body.expired, false);
  assert.equal(globalThis.__trialCalls.grant, 1);
  assert.equal(globalThis.__trialLastUser, USER.user_id, 'grantTrial must be called with user_id');
});

test('POST /api/users/me/trial/grant — idempotent re-call returns granted:false', async () => {
  const mod = await loadGrantRoute({
    user: USER,
    trial: { grantResult: { granted: false, songs_remaining: 1, expires_at: EXPIRY, expired: false } },
  });
  const res = await mod.POST();
  assert.equal(res.status, 200);
  assert.equal(res.body.granted, false, 'second call must report granted:false');
  assert.equal(res.body.songs_remaining, 1, 'existing songs_remaining must pass through');
});

test('POST /api/users/me/trial/grant — 503 when DB throws', async () => {
  const mod = await loadGrantRoute({
    user: USER,
    trial: { throwOnGrant: true },
  });
  const res = await mod.POST();
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'TRIAL_UNAVAILABLE');
});

// --- CONSUME -------------------------------------------------------------

test('POST /api/users/me/trial/consume — 401 when unauthenticated', async () => {
  const mod = await loadConsumeRoute({
    user: null,
    trial: { consumeResult: { ok: true, songs_remaining: 2, expires_at: EXPIRY } },
  });
  const res = await mod.POST();
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
  assert.equal(globalThis.__trialCalls.consume, 0);
});

test('POST /api/users/me/trial/consume — ok:true happy path', async () => {
  const mod = await loadConsumeRoute({
    user: USER,
    trial: { consumeResult: { ok: true, songs_remaining: 2, expires_at: EXPIRY } },
  });
  const res = await mod.POST();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.songs_remaining, 2);
  assert.equal(res.body.expires_at, EXPIRY);
  assert.equal(globalThis.__trialCalls.consume, 1);
});

for (const reason of ['no_grant', 'expired', 'exhausted']) {
  test(`POST /api/users/me/trial/consume — ok:false reason='${reason}'`, async () => {
    const mod = await loadConsumeRoute({
      user: USER,
      trial: { consumeResult: { ok: false, reason } },
    });
    const res = await mod.POST();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, reason);
  });
}

test('POST /api/users/me/trial/consume — 503 when DB throws', async () => {
  const mod = await loadConsumeRoute({
    user: USER,
    trial: { throwOnConsume: true },
  });
  const res = await mod.POST();
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'TRIAL_UNAVAILABLE');
});

// Round-2 FIX #3: this route is publicly reachable to any authed caller, so
// it must share /api/jobs' burst ceiling. When the limiter trips the route
// must 429 with rate_limit_burst and MUST NOT call consumeTrial().
test('POST /api/users/me/trial/consume — 429 when burst limit trips (round-2 FIX #3)', async () => {
  const mod = await loadConsumeRoute({
    user: USER,
    trial: { consumeResult: { ok: true, songs_remaining: 2, expires_at: EXPIRY } },
    burst: { limited: true },
  });
  const res = await mod.POST();
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'rate_limit_burst');
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal(globalThis.__burstCalls, 1, 'burst check must run');
  assert.equal(globalThis.__trialCalls.consume, 0, 'consume must NOT be called when burst-limited');
});

test('POST /api/users/me/trial/consume — burst check runs before consume (round-2 FIX #3)', async () => {
  const mod = await loadConsumeRoute({
    user: USER,
    trial: { consumeResult: { ok: true, songs_remaining: 2, expires_at: EXPIRY } },
    burst: { limited: false },
  });
  const res = await mod.POST();
  assert.equal(res.status, 200);
  assert.equal(globalThis.__burstCalls, 1, 'burst check runs even on the happy path');
  assert.equal(globalThis.__burstLastUser, USER.user_id);
  assert.equal(globalThis.__trialCalls.consume, 1);
});
