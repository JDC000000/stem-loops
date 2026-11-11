// POST /api/jobs link branch: PAID_LINK_INGEST_DISALLOWED wiring (TSD §1.2a).
// Harness copied from jobs-trial-channel.test.mjs (stubbed deps, no DB).


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
      if (action.startsWith('start_job_') && action !== 'start_job_upload' &&
          (cfg.planCode === 'pro' || cfg.planCode === 'studio')) {
        const e = new EntitlementError('PAID_LINK_INGEST_DISALLOWED', 'paid plans are upload-only');
        e.status = 400;
        throw e;
      }
      if (!cfg.enforce.allow) {
        throw new EntitlementError(cfg.enforce.code ?? 'CREDIT_BALANCE_INSUFFICIENT', cfg.enforce.message ?? 'denied');
      }
      return { allowed: true, snapshot: { plan_code: cfg.planCode, credits_remaining: 0 } };
    };
    export const invalidateEntitlement = () => {};
    // route.ts imports this to decide whether a free upload is on the credit
    // path or the monthly-quota path. Same call-time read as the real module.
    export const billingEnforced = () => process.env.BILLING_ENFORCED === 'true';
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
    .replace(/from ['"]@\/lib\/billing\/credits['"]/g, `from '${creditsStub()}'`)
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

const LINK = { url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 };

async function postLink({ user, planCode, trial }) {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    const mod = await loadRoute({ user, entitlements: { planCode }, trial });
    const res = await mod.POST(makeReq(LINK));
    return { res, calls: globalThis.__calls };
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
}

for (const plan of ['pro', 'studio']) {
  test(`link ingest from ${plan} user -> 400 PAID_LINK_INGEST_DISALLOWED`, async () => {
    const { res, calls } = await postLink({ user: USER, planCode: plan });
    assert.equal(res.status, 400);
    assert.equal(res.body.error_code, 'PAID_LINK_INGEST_DISALLOWED');
    const enf = calls.find((c) => c.fn === 'enforceEntitlement');
    assert.equal(enf.action, 'start_job_youtube');
    assert.equal(enf.userId, USER.user_id);
    // Rejected before admission, trial, burst, quota, or any insert.
    for (const fn of ['checkAdmission', 'consumeTrial', 'checkBurstLimit', 'checkMonthlyQuota', 'db.query', 'db.tx.query']) {
      assert.equal(calls.find((c) => c.fn === fn), undefined, `${fn} must not run`);
    }
  });
}

test('link ingest from free user -> allowed (201)', async () => {
  const { res, calls } = await postLink({ user: USER, planCode: 'free' });
  assert.equal(res.status, 201);
  assert.ok(calls.find((c) => c.fn === 'enforceEntitlement' && c.action === 'start_job_youtube'));
});

test('link ingest from free trial user -> allowed, trial consumed', async () => {
  const { res, calls } = await postLink({ user: USER, planCode: 'free' });
  assert.equal(res.status, 201);
  assert.ok(calls.find((c) => c.fn === 'consumeTrial'), 'trial path still runs');
});

test('link ingest from free user with exhausted trial -> not blocked by new guard', async () => {
  // Guard only acts on PAID_LINK_INGEST_DISALLOWED; other entitlement errors
  // are ignored so the existing fall-through behaviour holds.
  const { res } = await postLink({ user: USER, planCode: 'free', trial: { consumeResult: { ok: false } } });
  assert.notEqual(res.body?.error_code, 'PAID_LINK_INGEST_DISALLOWED');
  assert.equal(res.status, 201);
});

test('link ingest from anonymous user -> allowed, entitlement guard not called', async () => {
  const { res, calls } = await postLink({ user: null, planCode: 'free' });
  assert.equal(res.status, 201);
  assert.equal(calls.find((c) => c.fn === 'enforceEntitlement'), undefined);
});

test('upload branch untouched: pro upload does not hit the link guard', async () => {
  const mod = await loadRoute({ user: USER, entitlements: { planCode: 'pro' } });
  const res = await mod.POST(makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }));
  assert.equal(res.status, 201);
  const actions = globalThis.__calls.filter((c) => c.fn === 'enforceEntitlement').map((c) => c.action);
  assert.deepEqual(actions, ['start_job_upload']);
});
