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
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE, sameOriginHeaders } from './helpers/same-origin.mjs';

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
    // In-tx variant used by /api/jobs after PR #39 Lens A follow-up: the
    // consume now shares a tx with the jobs INSERT so a rate-limited INSERT
    // rolls the trial consume back. The stub records it under 'consumeTrial'
    // so existing assertions still match.
    export const consumeTrialInTx = async (_client, userId) => {
      globalThis.__calls.push({ fn: 'consumeTrial', userId });
      return cfg.consumeResult;
    };
    export const grantTrial = async () => ({ granted: false, songs_remaining: 3, expires_at: '2099-01-01T00:00:00Z', expired: false });
    export const readTrial = async () => ({ present: false });
  `);
}

function entitlementsStub({ planCode = 'free', enforce = { allow: true }, credits = 0 } = {}) {
  const payload = JSON.stringify({ planCode, enforce, credits });
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
      if (action.startsWith('start_job_') && action !== 'start_job_upload' &&
          (cfg.planCode === 'pro' || cfg.planCode === 'studio')) {
        const e = new EntitlementError('PAID_LINK_INGEST_DISALLOWED', 'paid plans are upload-only');
        e.status = 400;
        throw e;
      }
      if (!cfg.enforce.allow) {
        throw new EntitlementError(cfg.enforce.code ?? 'CREDIT_BALANCE_INSUFFICIENT', cfg.enforce.message ?? 'denied');
      }
      return {
        allowed: true,
        snapshot: { plan_code: cfg.planCode, credits_remaining: cfg.credits ?? 0 },
      };
    };
    export const invalidateEntitlement = () => {};
    // Mirrors the real entitlements.ts export: read at CALL time, never
    // captured at module load, so a test can flip it around a single POST.
    export const FREE_QUOTA_EXHAUSTED_MESSAGE = 'stub'; export const billingEnforced = () => process.env.BILLING_ENFORCED === 'true';
  `);
}

function creditsStub() {
  // consumeCreditInTx records itself so tests can assert the B1 wiring.
  return dataUrl(`
    globalThis.__calls = globalThis.__calls || [];
    export const consumeCreditInTx = async (_client, userId, jobId) => {
      globalThis.__calls.push({ fn: 'consumeCredit', userId, jobId });
    };
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
    export const bumpJobsUsedWithinQuota = async () => true; export const bumpJobsUsed = async () => {};
    export const rollPeriodIfStale = async () => {};
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
    .replace(/from ['"]@\/lib\/billing\/credits['"]/g, `from '${creditsStub()}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${rateLimitStub(rateLimit ?? {})}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${admissionStub(admission ?? {})}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub()}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIpStub()}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${youtubeUrlStub()}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${uploadStub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

function makeReq(body) {
  return {
    json: async () => body,
    headers: sameOriginHeaders(),
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
      enforce: { allow: false, code: 'CREDIT_BALANCE_INSUFFICIENT', message: 'credits depleted' },
    },
  });
  const res = await mod.POST(
    makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }),
  );
  assert.equal(res.status, 402, 'credits-depleted upload must 402');
  assert.equal(res.body.error_code, 'CREDIT_BALANCE_INSUFFICIENT');
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

test('POST /api/jobs — Pro user on link branch is blocked with PAID_LINK_INGEST_DISALLOWED', async () => {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    const mod = await loadRoute({
      user: USER,
      entitlements: { planCode: 'pro' },
    });
    const res = await mod.POST(
      makeReq({ url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 }),
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error_code, 'PAID_LINK_INGEST_DISALLOWED');
    const consumeCalled = globalThis.__calls.find((c) => c.fn === 'consumeTrial');
    assert.equal(consumeCalled, undefined, 'Pro plan must skip the trial path');
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
});

// ---------------------------------------------------------------------------
// FIX #4 — trial-consume + jobs INSERT single-tx race (PR #39 Lens A).
//
// Before: consumeTrial() committed in its own tx, THEN jobs INSERT ran in a
// separate tx. If the atomic rate-limit WHERE in the INSERT returned 0 rows,
// the trial song was burned without a job. After the fix the two share a tx
// and the INSERT-returned-0 path throws, so the tx rolls back and the trial
// song is NOT burned.
// ---------------------------------------------------------------------------

// A db.tx stub that forces INSERT rowCount:0 (atomic rate-limit miss) and
// records the tx outcome so we can tell commit from rollback apart.
function dbStubTxFailsInsert({ insertRowCount = 0 } = {}) {
  const payload = JSON.stringify({ insertRowCount });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    globalThis.__txOutcomes = globalThis.__txOutcomes || [];
    export const db = {
      query: async (text) => {
        globalThis.__calls.push({ fn: 'db.query', sql: text });
        return { rows: [{ id: 'row-ok' }], rowCount: 1 };
      },
      tx: async (fn) => {
        const client = {
          query: async (text) => {
            globalThis.__calls.push({ fn: 'db.tx.query', sql: text });
            // Any INSERT in the tx returns 0 rows: force the atomic
            // rate-limit miss. SELECTs and advisory-lock writes still pass.
            if (/^\\s*INSERT\\s+INTO\\s+jobs/i.test(text)) {
              return { rows: [], rowCount: cfg.insertRowCount };
            }
            return { rows: [{ id: 'row-ok' }], rowCount: 1 };
          },
        };
        try {
          const out = await fn(client);
          globalThis.__txOutcomes.push({ status: 'committed', value: out });
          return out;
        } catch (err) {
          globalThis.__txOutcomes.push({
            status: 'rolled_back',
            sentinel: typeof err === 'symbol' ? err.toString() : String(err),
          });
          throw err;
        }
      },
    };
  `);
}

// Build the route with a custom db stub (the default loadRoute() can't swap
// db-only). Mirrors loadRoute() otherwise.
async function loadRouteWithDb({
  user,
  trial,
  entitlements,
  rateLimit,
  admission,
  dbSource,
} = {}) {
  globalThis.__calls = [];
  globalThis.__txOutcomes = [];
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${trialStub(trial ?? {})}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${entitlementsStub(entitlements ?? {})}'`)
    .replace(/from ['"]@\/lib\/billing\/credits['"]/g, `from '${creditsStub()}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${rateLimitStub(rateLimit ?? {})}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${admissionStub(admission ?? {})}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbSource}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIpStub()}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${youtubeUrlStub()}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${uploadStub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

test('POST /api/jobs — rate-limited INSERT after trial consume rolls back the whole tx (FIX #4)', async () => {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    const mod = await loadRouteWithDb({
      user: USER,
      entitlements: { planCode: 'free' },
      // trial consume says ok:true; then the INSERT returns 0 → tx throws.
      trial: { consumeResult: { ok: true, songs_remaining: 2, expires_at: '2099-01-01T00:00:00Z' } },
      dbSource: dbStubTxFailsInsert({ insertRowCount: 0 }),
    });
    const res = await mod.POST(
      makeReq({ url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 }),
    );
    assert.equal(res.status, 429, 'rate-limited after consume must surface 429');
    assert.equal(res.body.error_code, 'RATE_LIMITED');
    // Core assertion: the tx that wrapped consume + INSERT MUST have rolled
    // back. The dbStub records 'rolled_back' when fn(client) threw.
    const firstTx = globalThis.__txOutcomes[0];
    assert.ok(firstTx, 'tx must have been attempted');
    assert.equal(
      firstTx.status,
      'rolled_back',
      'tx must roll back when INSERT returns 0 rows after a successful consume → trial not burned',
    );
    // And no second tx ran (we didn't fall through to the plain INSERT path).
    assert.equal(
      globalThis.__txOutcomes.length,
      1,
      'exactly one tx attempt for the rate-limited consume-then-insert path',
    );
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
});

test('POST /api/jobs — consume returning {ok:false} falls through to burst/quota path (FIX #4)', async () => {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    // Trial says exhausted. The first tx should commit (nothing changed),
    // then the plain INSERT path should run and succeed.
    const mod = await loadRouteWithDb({
      user: USER,
      entitlements: { planCode: 'free' },
      trial: { consumeResult: { ok: false, reason: 'exhausted' } },
      dbSource: dbStubTxFailsInsert({ insertRowCount: 1 }),
    });
    const res = await mod.POST(
      makeReq({ url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 }),
    );
    assert.equal(res.status, 201, 'exhausted trial must fall through and still 201');
    // Both the probe tx (consume=ok:false, no insert) AND the plain INSERT tx ran.
    // Both should be committed, not rolled back.
    for (const tx of globalThis.__txOutcomes) {
      assert.equal(tx.status, 'committed', 'tx outcomes must all commit when nothing throws');
    }
    // Burst + quota ran on the fall-through path.
    assert.ok(
      globalThis.__calls.find((c) => c.fn === 'checkBurstLimit'),
      'burst gate must run on the fall-through (exhausted-trial) path',
    );
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
});

// ---------------------------------------------------------------------------
// B1 — credit consume wiring on the upload branch (credit-ledger review).
// ---------------------------------------------------------------------------

test('POST /api/jobs — free user UPLOAD charges a credit in the jobs tx (B1)', async () => {
  // BILLING_ENFORCED=true is the credit-gate world this test was written for.
  // With the switch off the free upload rides the monthly quota instead and
  // charges nothing — asserted separately below.
  process.env.BILLING_ENFORCED = 'true';
  try {
    const mod = await loadRoute({ user: USER, entitlements: { planCode: 'free' } });
    const res = await mod.POST(makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }));
    assert.equal(res.status, 201);
    const charged = globalThis.__calls.filter((c) => c.fn === 'consumeCredit');
    assert.equal(charged.length, 1, 'exactly one credit charged');
    assert.equal(charged[0].userId, USER.user_id);
    assert.equal(charged[0].jobId, JOB_ID);
    // Consume must come AFTER the jobs INSERT (trigger needs the job row).
    const calls = globalThis.__calls;
    const insertIdx = calls.findIndex((c) => c.fn === 'db.tx.query' && /INSERT INTO jobs/.test(c.sql));
    assert.ok(insertIdx >= 0 && insertIdx < calls.findIndex((c) => c.fn === 'consumeCredit'));
    assert.equal(calls.find((c) => c.fn === 'consumeTrial'), undefined, 'no trial double-consume');
  } finally {
    delete process.env.BILLING_ENFORCED;
  }
});

for (const plan of ['pro', 'studio']) {
  test(`POST /api/jobs — ${plan} UPLOAD does NOT charge a credit (B1)`, async () => {
    const mod = await loadRoute({ user: USER, entitlements: { planCode: plan } });
    const res = await mod.POST(makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }));
    assert.equal(res.status, 201);
    assert.equal(globalThis.__calls.find((c) => c.fn === 'consumeCredit'), undefined);
  });
}
