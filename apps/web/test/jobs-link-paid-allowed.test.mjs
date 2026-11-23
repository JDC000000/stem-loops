// POST /api/jobs link branch after TSD-V3-DELTA §1.2a was REVERSED by Jon on
// 2026-11-16 (this file used to be jobs-link-paid-blocked.test.mjs):
//   • Pro / Studio may paste YouTube links; a paid link job is metered ONCE
//     (bumpJobsUsed, as a paid upload), never touches the trial or the free
//     allowance, and every gate refusal is returned to the subscriber;
//   • Free is unchanged on the trial path; outside it a link job spends one
//     unit of the free allowance, capped in the INSERT tx — including for a
//     free account holding credits, which used to get uncapped, uncharged
//     links (checkMonthlyQuota waives the quota for credit holders);
//   • credits are never spent on a link job;
//   • anonymous is unchanged.
// Harness copied from jobs-trial-channel.test.mjs (stubbed deps, no DB).


import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE, sameOriginHeaders } from './helpers/same-origin.mjs';
import { LINK_JOB_URL, LINK_JOB_IMPORT_RE, NO_PASTE_HOOKS_URL, LIBRARY_SERVER_IMPORT_RE } from './helpers/create-link-job.mjs';

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

// Emulates the REAL link gate's contract (entitlements.ts), driven by cfg:
// paid plans are refused unless the row lists youtube and quota remains.
function entitlementsStub({ planCode = 'free', services, jobsUsed = 0, quota, credits = 0 } = {}) {
  const payload = JSON.stringify({
    planCode,
    services: services ?? ['youtube'],
    jobsUsed,
    quota: quota ?? { free: 5, pro: 50, studio: 150 }[planCode],
    credits,
  });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    export class EntitlementError extends Error {
      constructor(code, message) {
        super(message ?? code);
        this.code = code;
        this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402;
        this.errorCopyKey = code;
      }
    }
    const snap = () => ({
      plan_code: cfg.planCode,
      period_start: null, period_end: null,
      jobs_used: cfg.jobsUsed, jobs_quota: cfg.quota,
      services: cfg.services, export: { stems: false, wav24: false },
      credits_remaining: cfg.credits,
      trial_songs_remaining: 3,
    });
    export const getEntitlementSnapshot = async (userId) => {
      globalThis.__calls.push({ fn: 'getEntitlementSnapshot', userId });
      return snap();
    };
    export const enforceEntitlement = async (action, userId) => {
      globalThis.__calls.push({ fn: 'enforceEntitlement', action, userId });
      const paid = cfg.planCode === 'pro' || cfg.planCode === 'studio';
      if (paid && action === 'start_job_youtube') {
        if (!cfg.services.includes('youtube')) throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'service not in plan');
        if (!(cfg.jobsUsed < cfg.quota)) throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'quota exhausted');
      }
      if (!paid && action === 'start_job_youtube' && !cfg.services.includes('youtube')) {
        throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'service not in plan');
      }
      return { allowed: true, snapshot: snap() };
    };
    export const invalidateEntitlement = () => {};
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

function rateLimitStub({ burst = false, quota = false, withinQuota = true, debitRecorded = true } = {}) {
  const payload = JSON.stringify({ burst, quota, withinQuota, debitRecorded });
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
    export const bumpJobsUsedWithinQuota = async (_c, userId, quota) => {
      globalThis.__calls.push({ fn: 'bumpJobsUsedWithinQuota', userId, quota });
      return cfg.withinQuota;
    };
    export const bumpJobsUsed = async (_c, userId) => {
      globalThis.__calls.push({ fn: 'bumpJobsUsed', userId });
    };
    export const rollPeriodIfStale = async (_c, userId) => {
      globalThis.__calls.push({ fn: 'rollPeriodIfStale', userId });
    };
    export const recordAllowanceDebit = async (_c, userId, jobId, opts) => {
      globalThis.__calls.push({ fn: 'recordAllowanceDebit', userId, jobId, trialSong: opts.trialSong });
      return cfg.debitRecorded ?? true;
    };
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
    export const RATE_LIMIT = 5; export const IN_FLIGHT_STATUSES = ['queued']; export const anonJobMaxInFlight = () => 2; export const anonJobDailyCap = () => 10; export const anonJobCapsWhere = () => 'true'; export const checkAnonJobCaps = async () => ({ allowed: true, error_code: null }); export const lockAnonIp = async () => {}; export const hasAnonPresign = async () => true; export const presignRecordKey = (i, j) => 'presign:' + i + ':' + j; export const anonPresignedWhere = () => 'true'; export const recordAnonPresign = async () => {};
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
  return dataUrl(`
    globalThis.__calls = globalThis.__calls || [];
    export const captureException = (err) => {
      globalThis.__calls.push({ fn: 'Sentry.captureException', message: String(err && err.message) });
    };
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
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${dataUrl(toJs(readFileSync(join(WEB, 'src/lib/error-copy.ts'), 'utf8')))}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub()}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIpStub()}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${youtubeUrlStub()}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${uploadStub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(LINK_JOB_IMPORT_RE, `from '${LINK_JOB_URL}'`)
    .replace(LIBRARY_SERVER_IMPORT_RE, `from '${NO_PASTE_HOOKS_URL}'`)
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

const LINK = { url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 };

async function postLink({ user, ent = {}, trial, rateLimit }) {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    const mod = await loadRoute({ user, entitlements: ent, trial, rateLimit });
    const res = await mod.POST(makeReq(LINK));
    return { res, calls: globalThis.__calls };
  } finally {
    delete process.env.ALLOW_YOUTUBE_INPUT;
  }
}

const count = (calls, fn) => calls.filter((c) => c.fn === fn).length;
const inserts = (calls) => calls.filter((c) => /INSERT INTO jobs/.test(c.sql ?? '')).length;
const NO_TRIAL = { consumeResult: { ok: false } };

// ── Pro / Studio ───────────────────────────────────────────────────────────

for (const plan of ['pro', 'studio']) {
  test(`${plan}: link job allowed (201) and counted exactly once, like a paid upload`, async () => {
    const { res, calls } = await postLink({ user: USER, ent: { planCode: plan } });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'queued');
    const enf = calls.find((c) => c.fn === 'enforceEntitlement');
    assert.equal(enf.action, 'start_job_youtube');
    assert.equal(inserts(calls), 1, 'one jobs row');
    assert.equal(count(calls, 'bumpJobsUsed'), 1, 'one paid quota unit');
    // SHOULD-1 (review of #282): period bookkeeping before metering, as the
    // paid upload does — and in that order.
    assert.equal(count(calls, 'rollPeriodIfStale'), 1, 'paid link rolls a stale period, like a paid upload');
    const roll = calls.findIndex((c) => c.fn === 'rollPeriodIfStale');
    const bump = calls.findIndex((c) => c.fn === 'bumpJobsUsed');
    assert.ok(roll !== -1 && roll < bump, 'roll before bump');
    assert.equal(count(calls, 'bumpJobsUsedWithinQuota'), 0, 'never the free allowance');
    assert.equal(count(calls, 'consumeTrial'), 0, 'never a trial song');
    assert.equal(count(calls, 'consumeCredit'), 0, 'never a credit');
    // The same pre-insert gates a paid upload runs.
    assert.equal(count(calls, 'checkBurstLimit'), 1);
    assert.equal(count(calls, 'checkMonthlyQuota'), 1);
  });

  test(`${plan}: a paid upload is metered the same way (parity pin)`, async () => {
    const mod = await loadRoute({ user: USER, entitlements: { planCode: plan } });
    const res = await mod.POST(makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }));
    assert.equal(res.status, 201);
    const calls = globalThis.__calls;
    assert.equal(count(calls, 'bumpJobsUsed'), 1);
    assert.equal(count(calls, 'bumpJobsUsedWithinQuota'), 0);
    assert.equal(count(calls, 'consumeCredit'), 0);
    assert.equal(count(calls, 'rollPeriodIfStale'), 1);
  });

  test(`${plan}: link and upload make the SAME metering calls (parity pin)`, async () => {
    const METER = ['rollPeriodIfStale', 'bumpJobsUsed', 'bumpJobsUsedWithinQuota', 'consumeCredit', 'consumeTrial'];
    const seq = (calls) => calls.filter((c) => METER.includes(c.fn)).map((c) => c.fn);
    const link = (await postLink({ user: USER, ent: { planCode: plan } })).calls;
    const mod = await loadRoute({ user: USER, entitlements: { planCode: plan } });
    await mod.POST(makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }));
    assert.deepEqual(seq(link), seq(globalThis.__calls));
    assert.deepEqual(seq(link), ['rollPeriodIfStale', 'bumpJobsUsed']);
  });

  test(`${plan}: quota exhausted -> 402 ENTITLEMENT_UNAVAILABLE with the allowance sentence, nothing spent`, async () => {
    const quota = plan === 'pro' ? 50 : 150;
    const { res, calls } = await postLink({ user: USER, ent: { planCode: plan, jobsUsed: quota } });
    assert.equal(res.status, 402);
    assert.equal(res.body.error_code, 'ENTITLEMENT_UNAVAILABLE');
    assert.equal(res.body.message, "You've used this month's allowance on your plan. Your account page shows when the period ends.");
    for (const fn of ['checkAdmission', 'consumeTrial', 'checkBurstLimit', 'checkMonthlyQuota', 'bumpJobsUsed', 'bumpJobsUsedWithinQuota', 'db.query', 'db.tx.query']) {
      assert.equal(count(calls, fn), 0, `${fn} must not run`);
    }
  });

  test(`${plan}: row without youtube (039 not applied yet) -> 402 with its own copy, no free-tier fallthrough`, async () => {
    const { res, calls } = await postLink({ user: USER, ent: { planCode: plan, services: [] } });
    assert.equal(res.status, 402);
    assert.equal(res.body.error_code, 'ENTITLEMENT_UNAVAILABLE');
    assert.equal(res.body.message, "YouTube links aren't switched on for your plan yet. Upload the audio file instead, or try again later.");
    for (const fn of ['checkAdmission', 'consumeTrial', 'bumpJobsUsed', 'bumpJobsUsedWithinQuota', 'db.query', 'db.tx.query']) {
      assert.equal(count(calls, fn), 0, `${fn} must not run`);
    }
  });

  test(`${plan}: never answered PAID_LINK_INGEST_DISALLOWED`, async () => {
    const { res } = await postLink({ user: USER, ent: { planCode: plan } });
    assert.notEqual(res.body?.error_code, 'PAID_LINK_INGEST_DISALLOWED');
    assert.notEqual(res.status, 400);
  });

  test(`${plan}: checkMonthlyQuota denial still answers 402 quota_exceeded`, async () => {
    const { res, calls } = await postLink({ user: USER, ent: { planCode: plan }, rateLimit: { quota: true } });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'quota_exceeded');
    assert.equal(inserts(calls), 0);
  });
}

// ── Free ───────────────────────────────────────────────────────────────────

test('free, trial song available -> 201 via the trial path, exactly as before', async () => {
  const { res, calls } = await postLink({ user: USER, ent: { planCode: 'free' } });
  assert.equal(res.status, 201);
  assert.ok(calls.find((c) => c.fn === 'enforceEntitlement' && c.action === 'start_job_youtube'));
  assert.equal(count(calls, 'consumeTrial'), 1, 'trial path still runs');
  assert.equal(inserts(calls), 1);
  assert.equal(count(calls, 'bumpJobsUsedWithinQuota'), 0);
});

test('free, no trial -> one unit of the free allowance, capped in the tx', async () => {
  const { res, calls } = await postLink({ user: USER, ent: { planCode: 'free' }, trial: NO_TRIAL });
  assert.equal(res.status, 201);
  assert.equal(inserts(calls), 1);
  const capped = calls.filter((c) => c.fn === 'bumpJobsUsedWithinQuota');
  assert.equal(capped.length, 1);
  assert.equal(capped[0].quota, 5, 'capped at the free plan quota');
  assert.equal(count(calls, 'bumpJobsUsed'), 0, 'no second, uncapped count');
  assert.equal(count(calls, 'rollPeriodIfStale'), 1);
  assert.equal(count(calls, 'consumeCredit'), 0);
});

test('free holding credits, no trial -> free allowance (capped), NO credit spent on a link', async () => {
  const { res, calls } = await postLink({ user: USER, ent: { planCode: 'free', credits: 7 }, trial: NO_TRIAL });
  assert.equal(res.status, 201);
  assert.equal(count(calls, 'consumeCredit'), 0, 'credits are for uploads (credit_consumption trigger, migration 013)');
  assert.equal(count(calls, 'bumpJobsUsedWithinQuota'), 1);
});

test('free, no credits, allowance spent under the lock -> 402 FREE_MONTHLY_QUOTA_EXHAUSTED, plain copy', async () => {
  const { res } = await postLink({
    user: USER,
    ent: { planCode: 'free', credits: 0 },
    trial: NO_TRIAL,
    rateLimit: { withinQuota: false },
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.equal(res.body.message, "You've used all your free tracks this month. Your allowance resets at the start of next month.");
});

// Jon, 2026-11-16 ("Cap at 5/month"): credit holders stay capped on links, and
// the refusal points them at what their credits do buy (SHOULD-2, review of #282).
test('free credit holder at the link cap -> 402, copy says credits still work on uploads, no leak', async () => {
  const { res, calls } = await postLink({
    user: USER,
    ent: { planCode: 'free', credits: 7 },
    trial: NO_TRIAL,
    rateLimit: { withinQuota: false },
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.equal(res.body.message, "You've used this month's free YouTube links. Your credits still work: upload the audio file instead.");
  assert.doesNotMatch(res.body.message, /[A-Z]{2,}_[A-Z_]+|link cap reached|credits held/);
  assert.equal(count(calls, 'consumeCredit'), 0, 'still no credit spent on a link');
});

test('free, gate refusal is ignored (existing fall-through behaviour holds)', async () => {
  const { res } = await postLink({ user: USER, ent: { planCode: 'free', services: [] } });
  assert.equal(res.status, 201);
});

// ── Anonymous ──────────────────────────────────────────────────────────────

test('anonymous -> allowed, entitlement guard not called, no metering', async () => {
  const { res, calls } = await postLink({ user: null });
  assert.equal(res.status, 201);
  assert.equal(count(calls, 'enforceEntitlement'), 0);
  assert.equal(count(calls, 'getEntitlementSnapshot'), 0);
  for (const fn of ['bumpJobsUsed', 'bumpJobsUsedWithinQuota', 'consumeTrial', 'consumeCredit']) {
    assert.equal(count(calls, fn), 0, fn);
  }
  // PR #300 MF-1: the signed-out INSERT runs inside a tx after the per-IP advisory lock
  // (lockAnonIp is stubbed here), so it is ONE tx query and no bare db.query.
  assert.equal(count(calls, 'db.tx.query'), 1, 'one capped anon INSERT, inside the per-IP-locked tx');
  assert.equal(count(calls, 'db.query'), 0);
});

test('upload branch untouched: pro upload does not hit the link guard', async () => {
  const mod = await loadRoute({ user: USER, entitlements: { planCode: 'pro' } });
  const res = await mod.POST(makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }));
  assert.equal(res.status, 201);
  const actions = globalThis.__calls.filter((c) => c.fn === 'enforceEntitlement').map((c) => c.action);
  assert.deepEqual(actions, ['start_job_upload']);
});

// ── QA-64: what a link job spent is recorded in the same tx, so an our-fault failure can
// give it back (worker job_failure.restore_allowance_if_owed, migration 042) ─────────────

const debits = (calls) => calls.filter((c) => c.fn === 'recordAllowanceDebit');

for (const plan of ['pro', 'studio']) {
  test(`${plan}: link job records its allowance unit (no trial song), after the debit, for this job id`, async () => {
    const { res, calls } = await postLink({ user: USER, ent: { planCode: plan } });
    assert.equal(res.status, 201);
    const d = debits(calls);
    assert.equal(d.length, 1, 'one debit record');
    assert.equal(d[0].trialSong, false);
    assert.equal(d[0].userId, USER.user_id);
    assert.equal(d[0].jobId, res.body.id, 'recorded against the job just created');
    const bump = calls.findIndex((c) => c.fn === 'bumpJobsUsed');
    const rec = calls.findIndex((c) => c.fn === 'recordAllowanceDebit');
    const ins = calls.findIndex((c) => /INSERT INTO jobs/.test(c.sql ?? ''));
    assert.ok(ins < bump && bump < rec, 'insert, then debit, then the record (period_start read after the bump)');
  });
}

test('free trial link job records the trial song AND the allowance unit it spent', async () => {
  const { res, calls } = await postLink({ user: USER, ent: { planCode: 'free' } });
  assert.equal(res.status, 201);
  assert.equal(count(calls, 'consumeTrial'), 1);
  const d = debits(calls);
  assert.equal(d.length, 1);
  assert.equal(d[0].trialSong, true);
  assert.equal(d[0].jobId, res.body.id);
});

test('free non-trial link job records one allowance unit, no trial song', async () => {
  const { res, calls } = await postLink({ user: USER, ent: { planCode: 'free' }, trial: NO_TRIAL });
  assert.equal(res.status, 201);
  const d = debits(calls);
  assert.equal(d.length, 1);
  assert.equal(d[0].trialSong, false);
  const cap = calls.findIndex((c) => c.fn === 'bumpJobsUsedWithinQuota');
  assert.ok(cap < calls.findIndex((c) => c.fn === 'recordAllowanceDebit'));
});

test('free link refused at the cap records nothing (nothing was spent)', async () => {
  const { res, calls } = await postLink({
    user: USER,
    ent: { planCode: 'free' },
    trial: NO_TRIAL,
    rateLimit: { withinQuota: false },
  });
  assert.equal(res.status, 402);
  assert.equal(debits(calls).length, 0);
});

test('anonymous link job records nothing (it spends no allowance)', async () => {
  const { res, calls } = await postLink({ user: null });
  assert.equal(res.status, 201);
  assert.equal(debits(calls).length, 0);
});

test('uploads are not recorded here (credit-funded uploads are refunded by REFUND_SQL)', async () => {
  for (const plan of ['free', 'pro']) {
    const mod = await loadRoute({ user: USER, entitlements: { planCode: plan } });
    const res = await mod.POST(makeReq({ jobId: JOB_ID, uploadKey: UPLOAD_KEY, loop_length_bars: 4 }));
    assert.equal(res.status, 201);
    assert.equal(debits(globalThis.__calls).length, 0, plan);
  }
});

test('migration 042 not applied: the link job is still created (201) and Sentry is told once', async () => {
  const { res, calls } = await postLink({ user: USER, ent: { planCode: 'pro' }, rateLimit: { debitRecorded: false } });
  assert.equal(res.status, 201);
  const reports = calls.filter((c) => c.fn === 'Sentry.captureException' && /migration 042/.test(c.message));
  assert.equal(reports.length, 1);
});
