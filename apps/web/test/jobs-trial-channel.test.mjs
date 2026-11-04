// /api/jobs trial channel-separation tests — V3 Phase 1a round-2 (TSD §1.2a).
//
// Round-1 FAIL findings being fixed here:
//
//   FIX #1 (channel separation). Before r2 the jobs route called
//   consumeTrial() for EVERY authed non-pro/studio user regardless of
//   input kind — so a free-tier UPLOAD burned a trial song (opposite of
//   TSD §1.2a, which reserves trial for link-ingest and reserves credits
//   for uploads). After r2:
//     • Upload branch: runs enforceEntitlement('start_job_upload') and
//       MUST NOT call consumeTrial().
//     • Link branch: runs consumeTrial() (authed, non-pro/studio only).
//
//   FIX #2 (admission-before-consume). consumeTrial() commits in its own
//   tx. If checkAdmission() rejected AFTER the trial was spent, the song
//   was already gone — leaked on a 429. After r2: the per-IP admission
//   check runs BEFORE consumeTrial() in the link branch, so a rate-limited
//   request cannot move songs_used.
//
// Stubs everything consumeTrial(), the entitlement snapshot/enforce calls,
// the burst/quota rate limiters, and checkAdmission so no real DB or
// network hit is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/jobs/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

function authStub(user) {
  return dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`);
}

// ---------------------------------------------------------------------------
// Stubs — each records every call so the tests can order them.
// ---------------------------------------------------------------------------

function trialStub({ consumeResult = { ok: true, songs_remaining: 2, expires_at: '2099-01-01T00:00:00Z' } } = {}) {
  const payload = JSON.stringify({ consumeResult });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    export const TRIAL_SONG_CAP = 3;
    export const consumeTrial = async (userId) => {
      globalThis.__calls.push({ fn: 'consumeTrial', userId });
      return cfg.consumeResult;
    };
    export const grantTrial = async () => ({ granted: false, songs_remaining: 3, expires_at: '2099-01-01T00:00:00Z', expired: false });
    export const readTrial = async () => ({ present: false });
  `);
}

function entitlementsStub({ planCode = 'free', enforce = { allow: true } } = {}) {
  const payload = JSON.stringify({ planCode, enforce });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    export class EntitlementError extends Error {
      constructor(code, message) {
        super(message ?? code);
        this.code = code;
        this.status = 402;
        this.errorCopyKey = code;
      }
    }
    export const getEntitlementSnapshot = async (userId) => {
      globalThis.__calls.push({ fn: 'getEntitlementSnapshot', userId });
      return {
        plan_code: cfg.planCode,
        period_start: null, period_end: null,
        jobs_used: 0, jobs_quota: 100,
        services: [], export: { stems: false, wav24: false },
        credits_remaining: cfg.enforce.allow ? 5 : 0,
        trial_songs_remaining: 3,
      };
    };
    export const enforceEntitlement = async (action, userId) => {
      globalThis.__calls.push({ fn: 'enforceEntitlement', action, userId });
      if (!cfg.enforce.allow) {
        throw new EntitlementError(cfg.enforce.code ?? 'CREDITS_DEPLETED', cfg.enforce.message ?? 'denied');
      }
      return { allowed: true, snapshot: { plan_code: cfg.planCode } };
    };
    export const invalidateEntitlement = () => {};
  `);
}

function rateLimitStub({ burst = false, quota = false } = {}) {
  const payload = JSON.stringify({ burst, quota });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    export const checkBurstLimit = async (userId) => {
      globalThis.__calls.push({ fn: 'checkBurstLimit', userId });
      return cfg.burst ? { kind: 'rate_limit_burst', retry_after_s: 60 } : null;
    };
    export const checkMonthlyQuota = async (userId) => {
      globalThis.__calls.push({ fn: 'checkMonthlyQuota', userId });
      return cfg.quota ? { kind: 'quota_exceeded', resets_at: '2099-01-01T00:00:00Z' } : null;
    };
    export const incrementJobsUsed = async () => {};
    export const BURST_WINDOW_MS = 60000;
    export const BURST_LIMIT_PER_USER = 3;
    export const UNLIMITED_QUOTA_SENTINEL = 100000;
  `);
}

function admissionStub({ allowed = true } = {}) {
  const payload = JSON.stringify({ allowed });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    export const checkAdmission = async (hash) => {
      globalThis.__calls.push({ fn: 'checkAdmission', hash });
      return cfg.allowed ? { allowed: true, error_code: null } : { allowed: false, error_code: 'RATE_LIMITED' };
    };
    export const RATE_WINDOW_MS = 60000;
    export const RATE_LIMIT = 5;
    export const checkUploadRate = async () => ({ allowed: true, error_code: null });
  `);
}

function dbStub() {
  return dataUrl(`
    globalThis.__calls = globalThis.__calls || [];
    export const db = {
      query: async (text) => {
        globalThis.__calls.push({ fn: 'db.query', sql: text });
        // Any insert claiming it was atomic with the rate-limit check must
        // see 1 row inserted so the route returns 201 on the happy path.
        return { rows: [{ id: 'row-ok' }], rowCount: 1 };
      },
      tx: async (fn) => {
        const client = {
          query: async (text) => {
            globalThis.__calls.push({ fn: 'db.tx.query', sql: text });
            return { rows: [{ id: 'row-ok' }], rowCount: 1 };
          },
        };
        return await fn(client);
      },
    };
  `);
}

function clientIpStub() {
  return dataUrl(`export const clientIpHashOf = () => 'test-hash';`);
}

function youtubeUrlStub() {
  return dataUrl(`export const canonicalizeYoutubeUrl = (u) => (typeof u === 'string' && u.includes('youtu') ? u : null);`);
}

function uploadStub() {
  return dataUrl(`export const isValidUploadKey = (jobId, key) => typeof key === 'string' && key.startsWith(jobId + '/');`);
}

function sentryStub() {
  return dataUrl(`export const captureException = () => {};`);
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

async function loadRoute({
  user,
  trial,
  entitlements,
  rateLimit,
  admission,
} = {}) {
  globalThis.__calls = [];
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${trialStub(trial ?? {})}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${entitlementsStub(entitlements ?? {})}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${rateLimitStub(rateLimit ?? {})}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${admissionStub(admission ?? {})}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub()}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIpStub()}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${youtubeUrlStub()}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${uploadStub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

function makeReq(body) {
  return {
    json: async () => body,
    headers: new Map(),
  };
}

const USER = { user_id: '11111111-1111-1111-1111-111111111111', email: 'u@x.co' };
const JOB_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPLOAD_KEY = `${JOB_ID}/_input.mp3`;

// ---------------------------------------------------------------------------
// FIX #1 — channel separation (TSD §1.2a).
// ---------------------------------------------------------------------------

test('POST /api/jobs — authed free user UPLOAD does NOT consume trial (FIX #1)', async () => {
  const mod = await loadRoute({
    user: USER,
    entitlements: { planCode: 'free', enforce: { allow: true } },
  });
  const res = await mod.POST(
    makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }),
  );
  assert.equal(res.status, 201, 'upload must succeed');
  const calls = globalThis.__calls;
  const consumeCalled = calls.find((c) => c.fn === 'consumeTrial');
  assert.equal(consumeCalled, undefined, 'consumeTrial MUST NOT fire on the upload branch');
  const enforceCalled = calls.find(
    (c) => c.fn === 'enforceEntitlement' && c.action === 'start_job_upload',
  );
  assert.ok(enforceCalled, 'enforceEntitlement(start_job_upload) must run on the upload branch');
});

test('POST /api/jobs — authed free user UPLOAD blocked by credits returns 402 (FIX #1 §1.2a)', async () => {
  const mod = await loadRoute({
    user: USER,
    entitlements: {
      planCode: 'free',
      enforce: { allow: false, code: 'CREDITS_DEPLETED', message: 'credits depleted' },
    },
  });
  const res = await mod.POST(
    makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }),
  );
  assert.equal(res.status, 402, 'credits-depleted upload must 402');
  assert.equal(res.body.error_code, 'CREDITS_DEPLETED');
  // And STILL no trial burn — this is the channel-separation core assertion.
  const consumeCalled = globalThis.__calls.find((c) => c.fn === 'consumeTrial');
  assert.equal(consumeCalled, undefined, 'credits-depleted upload MUST NOT burn a trial song');
});

test('POST /api/jobs — authed free user YouTube link CONSUMES trial (FIX #1)', async () => {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    const mod = await loadRoute({
      user: USER,
      entitlements: { planCode: 'free' },
    });
    const res = await mod.POST(
      makeReq({ url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 }),
    );
    assert.equal(res.status, 201, 'link ingest must succeed');
    const calls = globalThis.__calls;
    const consumeCalled = calls.find((c) => c.fn === 'consumeTrial');
    assert.ok(consumeCalled, 'consumeTrial MUST fire on the link-ingest branch');
    assert.equal(consumeCalled.userId, USER.user_id);
    // And enforceEntitlement('start_job_upload') MUST NOT be called here.
    const enforceUpload = calls.find(
      (c) => c.fn === 'enforceEntitlement' && c.action === 'start_job_upload',
    );
    assert.equal(enforceUpload, undefined, 'upload entitlement must not run on link branch');
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
});

// ---------------------------------------------------------------------------
// FIX #2 — admission-before-consume (TSD §1.2a).
// ---------------------------------------------------------------------------

test('POST /api/jobs — rate-limited link request does NOT consume trial (FIX #2)', async () => {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    const mod = await loadRoute({
      user: USER,
      entitlements: { planCode: 'free' },
      admission: { allowed: false },
    });
    const res = await mod.POST(
      makeReq({ url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 }),
    );
    assert.equal(res.status, 429, 'rate-limited link request must 429');
    assert.equal(res.body.error_code, 'RATE_LIMITED');
    const consumeCalled = globalThis.__calls.find((c) => c.fn === 'consumeTrial');
    assert.equal(
      consumeCalled,
      undefined,
      'rate-limited request MUST NOT move trial songs_used (round-2 FIX #2)',
    );
    // Order sanity: checkAdmission appears BEFORE anywhere consumeTrial
    // could have been reached.
    const admissionIdx = globalThis.__calls.findIndex((c) => c.fn === 'checkAdmission');
    assert.ok(admissionIdx !== -1, 'checkAdmission must run');
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
});

test('POST /api/jobs — Pro user on link branch skips trial consume', async () => {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    const mod = await loadRoute({
      user: USER,
      entitlements: { planCode: 'pro' },
    });
    const res = await mod.POST(
      makeReq({ url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 }),
    );
    assert.equal(res.status, 201);
    const consumeCalled = globalThis.__calls.find((c) => c.fn === 'consumeTrial');
    assert.equal(consumeCalled, undefined, 'Pro plan must skip the trial path');
    // Burst gate still runs for Pro.
    const burstCalled = globalThis.__calls.find((c) => c.fn === 'checkBurstLimit');
    assert.ok(burstCalled, 'burst gate must run for Pro');
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
});
