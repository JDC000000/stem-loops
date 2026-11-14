// Follow-up to #259 (copy batch D: entitlement refusals reach the user as copy).
//
// An EntitlementError's .message is internal: it can be a bare code, a reason string
// ('quota exhausted', 'service not in plan', 'plan pro missing from plans table') or the
// text of a database error (entitlements.ts wraps a failed snapshot read as
// ENTITLEMENT_UNAVAILABLE with err.message). None of that may reach the browser. The route
// sends entitlementMessage(code, detail) instead, which is built from ERROR_COPY only.
//
// The #259 review found that nothing pinned this: putting err.message back at a route site,
// or letting the fallback return the detail, left every test green (mutants D3-D6). These
// tests fail if an internal code or reason string reaches the response copy.
//
// Two layers:
//   1. entitlementMessage() itself, with hostile details.
//   2. POST /api/jobs at all three refusal sites, through the real error-copy module, with
//      a marker in the thrown message. Harness follows jobs-link-paid-blocked.test.mjs.

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

const ERROR_COPY_URL = () => dataUrl(toJs(readFileSync(join(WEB, 'src/lib/error-copy.ts'), 'utf8')));
const copy = await import(ERROR_COPY_URL() + '#' + Math.random());

// What a failed snapshot read looks like when entitlements.ts wraps it (entitlements.ts:336).
const MARKER = 'LEAKMARK-7f3a';
const DB_TEXT = `${MARKER} relation "public.entitlements" does not exist (SQLSTATE 42P01) at 10.0.0.12:5432 role stemloops_app`;

// Every code EntitlementError can carry (EntitlementErrorCode in entitlements.ts).
const ENTITLEMENT_CODES = [
  'ENTITLEMENT_UNAVAILABLE',
  'PLAN_NOT_FOUND',
  'TRIAL_EXHAUSTED',
  'CREDIT_BALANCE_INSUFFICIENT',
  'FREE_MONTHLY_QUOTA_EXHAUSTED',
  'PAID_LINK_INGEST_DISALLOWED',
];

// Every internal reason string entitlements.ts / route.ts throw as the message today.
const INTERNAL_DETAILS = [
  DB_TEXT,
  'service not in plan',
  'plan pro missing from plans table',
  'stem export is included in Studio only',
  'wav24 is not a paid gate: every plan gets 24-bit WAV loops',
  'unknown action start_job_tiktok',
  'paid plans are upload-only',
];

const ALL_CODES_RE = new RegExp(`\\b(${[...ENTITLEMENT_CODES, 'INTERNAL_ERROR'].join('|')})\\b`);

/** The copy a code must render to: headline + action from ERROR_COPY, nothing else. */
const expected = (code) => {
  const c = copy.ERROR_COPY[code];
  return c.action ? `${c.headline} ${c.action}` : c.headline;
};
const DEFAULT_SENTENCE = `${copy.DEFAULT_ERROR.headline} ${copy.DEFAULT_ERROR.action}`;
const OVER_QUOTA_SENTENCE =
  "You've used this month's allowance on your plan. Your account page shows when the period ends.";

function assertNoLeak(message, detail, label) {
  assert.equal(typeof message, 'string', `${label}: message is a string`);
  assert.ok(message.length > 0, `${label}: message is not empty`);
  if (detail) assert.ok(!message.includes(detail), `${label}: the thrown detail reached the copy: ${message}`);
  assert.ok(!message.includes(MARKER), `${label}: the marker reached the copy: ${message}`);
  assert.ok(!ALL_CODES_RE.test(message), `${label}: an internal code reached the copy: ${message}`);
  assert.ok(!/SQLSTATE|relation "|stemloops_app|5432/.test(message), `${label}: database text reached the copy`);
}

// ---------------------------------------------------------------------------
// 1. entitlementMessage()
// ---------------------------------------------------------------------------

for (const code of ENTITLEMENT_CODES) {
  test(`entitlementMessage(${code}, <internal detail>) is exactly its ERROR_COPY sentence, never the detail`, () => {
    for (const detail of [undefined, '', code, ...INTERNAL_DETAILS]) {
      const msg = copy.entitlementMessage(code, detail);
      assertNoLeak(msg, detail, `${code} / ${JSON.stringify(detail)}`);
      assert.equal(msg, expected(code), `${code} with detail ${JSON.stringify(detail)}`);
    }
  });
}

test('entitlementMessage: an unknown code falls back to the default sentence, never the detail or the code', () => {
  for (const code of ['SOME_NEW_CODE', 'DB_DOWN', '', 'select 1']) {
    for (const detail of [undefined, code, ...INTERNAL_DETAILS]) {
      const msg = copy.entitlementMessage(code, detail);
      assert.equal(msg, DEFAULT_SENTENCE, `${JSON.stringify(code)} / ${JSON.stringify(detail)}`);
      assertNoLeak(msg, detail, `${JSON.stringify(code)} / ${JSON.stringify(detail)}`);
      if (code) assert.ok(!msg.includes(code), 'the unknown code is not echoed');
    }
  }
});

test('entitlementMessage: paid over-quota ("quota exhausted") gets the allowance sentence, not the reason string', () => {
  const msg = copy.entitlementMessage('ENTITLEMENT_UNAVAILABLE', 'quota exhausted');
  assert.equal(msg, OVER_QUOTA_SENTENCE);
  assert.notEqual(msg, expected('ENTITLEMENT_UNAVAILABLE'), 'over quota is not "we could not verify your plan"');
  assert.ok(!/quota exhausted/i.test(msg));
  assertNoLeak(msg, 'quota exhausted', 'over quota');
  // The special case is keyed on the code too: the same reason under another code is not it.
  assert.equal(copy.entitlementMessage('PLAN_NOT_FOUND', 'quota exhausted'), expected('PLAN_NOT_FOUND'));
});

// ---------------------------------------------------------------------------
// 2. POST /api/jobs: the three refusal sites
// ---------------------------------------------------------------------------

function entitlementsStub(cfg) {
  return dataUrl(`
    const cfg = ${JSON.stringify(cfg)};
    globalThis.__calls = globalThis.__calls || [];
    export class EntitlementError extends Error {
      constructor(code, message) {
        super(message ?? code);
        this.name = 'EntitlementError';
        this.code = code;
        this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402;
        this.errorCopyKey = code;
      }
    }
    globalThis.__EntitlementError = EntitlementError;
    export const getEntitlementSnapshot = async () => ({
      plan_code: cfg.planCode, period_start: null, period_end: null, jobs_used: 0, jobs_quota: 5,
      services: [], export: { stems: false, wav24: false }, credits_remaining: cfg.credits, trial_songs_remaining: 0,
    });
    export const enforceEntitlement = async (action, userId) => {
      globalThis.__calls.push({ fn: 'enforceEntitlement', action, userId });
      const t = cfg.throwOn && cfg.throwOn[action];
      if (t) throw new EntitlementError(t.code, t.message);
      return { allowed: true, snapshot: { plan_code: cfg.planCode, credits_remaining: cfg.credits, jobs_quota: 5 } };
    };
    export const invalidateEntitlement = () => {};
    export const FREE_QUOTA_EXHAUSTED_MESSAGE = cfg.freeQuotaMessage;
    export const billingEnforced = () => process.env.BILLING_ENFORCED === 'true';
  `);
}

function creditsStub(cfg) {
  return dataUrl(`
    const cfg = ${JSON.stringify(cfg)};
    globalThis.__calls = globalThis.__calls || [];
    export const consumeCreditInTx = async (_client, userId, jobId) => {
      globalThis.__calls.push({ fn: 'consumeCredit', userId, jobId });
      if (cfg.consumeThrows) throw new globalThis.__EntitlementError(cfg.consumeThrows.code, cfg.consumeThrows.message);
    };
  `);
}

function rateLimitStub(cfg) {
  return dataUrl(`
    const cfg = ${JSON.stringify(cfg)};
    export const checkBurstLimit = async () => null;
    export const checkMonthlyQuota = async () => null;
    export const bumpJobsUsedWithinQuota = async () => cfg.withinQuota;
    export const bumpJobsUsed = async () => {};
    export const rollPeriodIfStale = async () => {};
  `);
}

const STUBS = {
  trial: dataUrl(`
    export const consumeTrialInTx = async () => ({ ok: true, songs_remaining: 2, expires_at: '2099-01-01T00:00:00Z' });
    export const consumeTrial = consumeTrialInTx;
  `),
  admission: dataUrl(`
    export const checkAdmission = async () => ({ allowed: true, error_code: null });
    export const checkUploadRate = async () => ({ allowed: true, error_code: null });
    export const RATE_WINDOW_MS = 60000;
    export const RATE_LIMIT = 5;
  `),
  db: dataUrl(`
    export const db = {
      query: async () => ({ rows: [{ id: 'row-ok' }], rowCount: 1 }),
      tx: async (fn) => fn({ query: async () => ({ rows: [{ id: 'row-ok' }], rowCount: 1 }) }),
    };
  `),
  clientIp: dataUrl(`export const clientIpHashOf = () => 'test-hash';`),
  youtube: dataUrl(`export const canonicalizeYoutubeUrl = (u) => (typeof u === 'string' && u.includes('youtu') ? u : null);`),
  upload: dataUrl(`export const isValidUploadKey = (jobId, key) => typeof key === 'string' && key.startsWith(jobId + '/');`),
  sentry: dataUrl(`export const captureException = () => {};`),
  next: dataUrl(`
    export class NextResponse {
      constructor(rawBody, init = {}) {
        this.status = (init && init.status) ?? 200;
        this.headers = new Map(Object.entries((init && init.headers) || {}));
        try { this.body = JSON.parse(rawBody); } catch { this.body = rawBody; }
      }
      static json(body, init = {}) {
        return { status: init.status ?? 200, body, headers: new Map(Object.entries((init && init.headers) || {})) };
      }
    }
  `),
};

const USER = { user_id: '11111111-1111-1111-1111-111111111111', email: 'u@x.co' };
const JOB_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function loadRoute({ ent, credits = {}, rate = { withinQuota: true } }) {
  globalThis.__calls = [];
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${dataUrl(`export const getUser = async () => (${JSON.stringify(USER)});`)}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${STUBS.trial}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${entitlementsStub(ent)}'`)
    .replace(/from ['"]@\/lib\/billing\/credits['"]/g, `from '${creditsStub(credits)}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${rateLimitStub(rate)}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${STUBS.admission}'`)
    // The REAL copy module: the mapping under test.
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${ERROR_COPY_URL()}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${STUBS.db}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${STUBS.clientIp}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${STUBS.youtube}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${STUBS.upload}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${STUBS.sentry}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${STUBS.next}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

const req = (body) => ({ json: async () => body, headers: sameOriginHeaders() });
const UPLOAD = { jobId: JOB_ID, uploadKey: `${JOB_ID}/_input.mp3`, loop_length_bars: 4 };
const LINK = { url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 };

async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function assertRefusal(res, { code, status, detail, message }) {
  assert.equal(res.status, status);
  assert.equal(res.body.error_code, code, 'the code goes in error_code, for the client to look up');
  assertNoLeak(res.body.message, detail, `${code} response`);
  assert.equal(res.body.message, message);
  // Nowhere in the body, not just the message field.
  const whole = JSON.stringify(res.body);
  assert.ok(!whole.includes(MARKER), 'the marker is nowhere in the response body');
  if (detail) assert.ok(!whole.includes(detail), 'the thrown detail is nowhere in the response body');
}

// Site 1: the upload gate (enforceEntitlement('start_job_upload')). The snapshot-failure
// text flows through here.
for (const [code, detail] of [
  ['ENTITLEMENT_UNAVAILABLE', DB_TEXT],
  ['PLAN_NOT_FOUND', `plan pro missing from plans table ${MARKER}`],
  ['CREDIT_BALANCE_INSUFFICIENT', `CREDIT_BALANCE_INSUFFICIENT ${MARKER}`],
  ['FREE_MONTHLY_QUOTA_EXHAUSTED', `jobs_used=5 quota=5 ${MARKER}`],
]) {
  test(`upload gate: ${code} thrown with internal text -> copy only, no leak`, async () => {
    const mod = await loadRoute({
      ent: { planCode: 'free', credits: 0, freeQuotaMessage: 'unused', throwOn: { start_job_upload: { code, message: detail } } },
    });
    const res = await mod.POST(req(UPLOAD));
    assertRefusal(res, { code, status: 402, detail, message: expected(code) });
  });
}

test('upload gate: paid over-quota ("quota exhausted") -> the allowance sentence, not the reason string', async () => {
  const mod = await loadRoute({
    ent: { planCode: 'pro', credits: 0, freeQuotaMessage: 'unused', throwOn: { start_job_upload: { code: 'ENTITLEMENT_UNAVAILABLE', message: 'quota exhausted' } } },
  });
  const res = await mod.POST(req(UPLOAD));
  assertRefusal(res, { code: 'ENTITLEMENT_UNAVAILABLE', status: 402, detail: 'quota exhausted', message: OVER_QUOTA_SENTENCE });
});

// Site 2: refusals thrown inside the jobs-insert transaction.
test('in-tx: lost the race for the last credit (billing enforced) -> copy only, no leak', async () => {
  const detail = `insert or update on table "credit_consumption" violates check ${MARKER}`;
  await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
    const mod = await loadRoute({
      ent: { planCode: 'free', credits: 1, freeQuotaMessage: 'unused' },
      credits: { consumeThrows: { code: 'CREDIT_BALANCE_INSUFFICIENT', message: detail } },
    });
    const res = await mod.POST(req(UPLOAD));
    assert.ok(globalThis.__calls.some((c) => c.fn === 'consumeCredit'), 'the refusal came from inside the tx');
    assertRefusal(res, { code: 'CREDIT_BALANCE_INSUFFICIENT', status: 402, detail, message: expected('CREDIT_BALANCE_INSUFFICIENT') });
  });
});

test('in-tx: free allowance cap hit under the quota lock -> copy only, not FREE_QUOTA_EXHAUSTED_MESSAGE', async () => {
  const detail = `free quota exhausted (internal) ${MARKER}`;
  await withEnv({ BILLING_ENFORCED: 'false' }, async () => {
    const mod = await loadRoute({
      ent: { planCode: 'free', credits: 0, freeQuotaMessage: detail },
      rate: { withinQuota: false },
    });
    const res = await mod.POST(req(UPLOAD));
    assertRefusal(res, { code: 'FREE_MONTHLY_QUOTA_EXHAUSTED', status: 402, detail, message: expected('FREE_MONTHLY_QUOTA_EXHAUSTED') });
  });
});

// Site 3: the link gate (enforceEntitlement('start_job_youtube')) for a paid plan.
test('link gate: PAID_LINK_INGEST_DISALLOWED thrown with internal text -> copy only, no leak', async () => {
  const detail = `paid plans are upload-only ${MARKER}`;
  await withEnv({ ALLOW_YOUTUBE_INPUT: 'true' }, async () => {
    const mod = await loadRoute({
      ent: { planCode: 'studio', credits: 0, freeQuotaMessage: 'unused', throwOn: { start_job_youtube: { code: 'PAID_LINK_INGEST_DISALLOWED', message: detail } } },
    });
    const res = await mod.POST(req(LINK));
    assertRefusal(res, { code: 'PAID_LINK_INGEST_DISALLOWED', status: 400, detail, message: expected('PAID_LINK_INGEST_DISALLOWED') });
  });
});
