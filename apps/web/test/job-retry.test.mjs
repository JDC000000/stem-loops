// Phase B B3 (#321): "Try again" on a failed link song. POST/GET /api/jobs/:id/retry,
// lib/jobs/retry-policy.ts, and create-link-job.ts's funding mode mirror_restore.
//
// Instrument: the REAL route (app/api/jobs/[id]/retry/route.ts), the REAL lib (via
// helpers/create-link-job.mjs: it has no runtime imports), the REAL retry policy, error copy,
// same-origin guard and retention SQL, against a stateful fake world that holds the rows the
// money path writes: jobs (with retry_of / retry_depth / retried_at / attempts),
// job_allowance_debits, entitlements.jobs_used, trial_grants.songs_used and burst rows.
// Transactions run CONCURRENTLY with an undo log (rolled back on a throw), and `SELECT … FOR
// UPDATE` takes a real per-row lock held to COMMIT/ROLLBACK — so dropping the parent lock lets
// two simultaneous retries both insert, as it would in Postgres. Every dependency call is
// logged, so which gates a retry passes is asserted exactly.
//
// The same cases run against a REAL Postgres in test/job-retry-pg.test.mjs (CI's Tests job).
// No DB here: nothing needs DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LINK_JOB_URL } from './helpers/create-link-job.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..', '..');
const read = (rel) => readFileSync(join(WEB, rel), 'utf8');
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const errorCopyUrl = dataUrl(toJs(read('src/lib/error-copy.ts')));
const copy = await import(errorCopyUrl);
const policyUrl = dataUrl(
  toJs(read('src/lib/jobs/retry-policy.ts')).replace(/from ['"]@\/lib\/jobs\/create-link-job['"]/g, `from '${LINK_JOB_URL}'`),
);
const policy = await import(policyUrl);
const lib = await import(LINK_JOB_URL);

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const PARENT = '11111111-1111-4111-8111-111111111111';
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const HOST = 'stem-loops.com';

// ── the fake world ────────────────────────────────────────────────────────────────────────

class EntitlementError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
    this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402;
  }
}

/**
 * o.plan 'free'|'pro'; o.jobsUsed; o.quota (5); o.trial {used, limit, expired} | null;
 * o.parent overrides; o.restore: the parent's debit row ({restored_at, allowance_restored,
 * trial_restored}) or null; o.ipFull; o.burst; o.admission; o.user (signed-in id or null).
 */
function world(o = {}) {
  const st = {
    jobs: new Map(),
    debits: new Map(),
    jobsUsed: o.jobsUsed ?? 0,
    trial: o.trial === undefined ? null : { ...o.trial },
    burst: 0,
    log: [],
    sql: [],
  };
  const quota = o.quota ?? 5;
  st.jobs.set(PARENT, {
    id: PARENT, user_id: USER, is_demo: false, input_kind: 'youtube', status: 'failed', error_code: 'FETCH_PROXY_FAILED',
    youtube_url: CANON, requested_stems: ['drums', 'bass'], loop_length_bars: 4, retry_of: null, retry_depth: 0,
    retried_at: null, updated_at: new Date(Date.now() - 3600_000).toISOString(), attempts: 1, created: 0,
    ...(o.parent ?? {}),
  });
  if (o.restore) st.debits.set(PARENT, { job_id: PARENT, trial_song: false, period: 'P0', ...o.restore });
  let seq = 0;
  let created = 1;
  const locks = new Map(); // row id -> promise released at tx end

  const debitsOf = (id) => {
    const d = st.debits.get(id);
    return d ? { restored_at: d.restored_at ?? null, allowance_restored: d.allowance_restored ?? null, trial_restored: d.trial_restored ?? null } : undefined;
  };
  const rows = (r) => ({ rows: r ? [r] : [], rowCount: r ? 1 : 0 });
  const tick = () => new Promise((r) => setImmediate(r));

  async function query(sql, params, tx) {
    const s = String(sql).trim();
    st.sql.push(s.split(/\s+/).slice(0, 6).join(' '));
    await tick();
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(s)) return rows(null);
    if (/^SELECT id, user_id, is_demo, input_kind, status, error_code/.test(s)) {
      const j = st.jobs.get(params[0]);
      return rows(j && !j.expired ? { ...j } : null);
    }
    if (/^SELECT (d\.)?restored_at, (d\.)?allowance_restored, (d\.)?trial_restored\s+FROM public\.job_allowance_debits/.test(s)) {
      if (o.no042) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return rows(debitsOf(params[0]));
    }
    if (/^SELECT id, user_id, status, input_kind, retry_depth, retried_at\s+FROM jobs WHERE id = \$1::uuid/.test(s)) {
      if (/FOR UPDATE/.test(s)) {
        if (!tx) throw new Error('FOR UPDATE outside a transaction');
        while (locks.has(params[0]) && locks.get(params[0]).owner !== tx) await locks.get(params[0]).p;
        if (!locks.has(params[0])) {
          let release;
          const p = new Promise((r) => (release = r));
          locks.set(params[0], { owner: tx, p, release });
          tx.locks.push(params[0]);
        }
      }
      const j = st.jobs.get(params[0]);
      return rows(j ? { id: j.id, user_id: j.user_id, status: j.status, input_kind: j.input_kind, retry_depth: j.retry_depth, retried_at: j.retried_at } : null);
    }
    if (/^SELECT retry_of FROM jobs WHERE id = \$1/.test(s)) {
      const j = st.jobs.get(params[0]);
      return rows(j ? { retry_of: j.retry_of } : null);
    }
    if (/^SELECT id FROM jobs WHERE retry_of = \$1/.test(s)) {
      const kids = [...st.jobs.values()].filter((j) => j.retry_of === params[0]).sort((a, b) => b.created - a.created);
      return rows(kids[0] ? { id: kids[0].id } : null);
    }
    if (/^INSERT INTO jobs/.test(s)) {
      st.log.push('INSERT');
      assert.match(s, /WHERE \(SELECT COUNT\(\*\) FROM jobs WHERE client_ip_hash = \$5/, 'the per-IP WHERE is on the retry INSERT');
      if (o.ipFull) return rows(null);
      const hasRetry = /retry_of, retry_depth/.test(s);
      const depth = hasRetry ? Number(params[9]) : 0;
      if (!(depth >= 0 && depth <= 2)) throw Object.assign(new Error('violates check constraint "jobs_retry_depth_range"'), { code: '23514' });
      const j = {
        id: params[0], user_id: params[7], is_demo: false, input_kind: 'youtube', status: 'queued', error_code: null,
        youtube_url: params[1], requested_stems: params[2], loop_length_bars: params[3], client_ip_hash: params[4],
        retry_of: hasRetry ? params[8] : null, retry_depth: depth, retried_at: null, attempts: 0, created: created++,
      };
      st.jobs.set(j.id, j);
      tx.undo.push(() => st.jobs.delete(j.id));
      return rows({ id: j.id });
    }
    if (/^UPDATE jobs SET/.test(s)) {
      const j = st.jobs.get(params[0]);
      const prev = { ...j };
      if (/retried_at = now\(\)/.test(s)) j.retried_at = new Date().toISOString();
      if (/attempts/.test(s)) j.attempts += 1;
      st.log.push('MARK_RETRIED');
      tx.undo.push(() => st.jobs.set(j.id, prev));
      return rows({});
    }
    if (/^INSERT INTO public\.job_allowance_debits/.test(s)) {
      st.log.push('trialOnlyDebit');
      if (!st.debits.has(params[0])) {
        st.debits.set(params[0], { job_id: params[0], period: null, trial_song: true });
        tx.undo.push(() => st.debits.delete(params[0]));
      }
      return rows(null);
    }
    throw new Error('unexpected SQL: ' + s);
  }

  const db = {
    query: (sql, params) => query(sql, params, null),
    tx: async (fn) => {
      const tx = { undo: [], locks: [] };
      const client = { query: (sql, params) => query(sql, params, tx), tx };
      st.log.push('BEGIN');
      try {
        const r = await fn(client);
        st.log.push('COMMIT');
        return r;
      } catch (e) {
        for (const u of tx.undo.reverse()) u();
        st.log.push('ROLLBACK');
        throw e;
      } finally {
        for (const id of tx.locks) { const l = locks.get(id); locks.delete(id); l.release(); }
      }
    },
  };

  const snap = () => ({
    plan_code: o.plan ?? 'free',
    jobs_quota: (o.plan ?? 'free') === 'pro' ? 1_000_000 : quota,
    credits_remaining: 0,
  });
  const deps = {
    getUser: async () => (o.user === undefined ? { user_id: USER } : o.user === null ? null : { user_id: o.user }),
    checkAdmission: async () => { st.log.push('checkAdmission'); return o.admission ?? { allowed: true, error_code: null }; },
    checkBurstLimit: async () => { st.log.push('checkBurstLimit'); st.burst += 1; return o.burst ?? null; },
    checkMonthlyQuota: async () => {
      st.log.push('checkMonthlyQuota');
      if ((o.plan ?? 'free') === 'pro') return null;
      return st.jobsUsed >= quota ? { resets_at: '2026-12-01T00:00:00Z' } : null;
    },
    bumpJobsUsed: async (c) => { st.log.push('bumpJobsUsed'); st.jobsUsed += 1; c.tx.undo.push(() => (st.jobsUsed -= 1)); },
    bumpJobsUsedWithinQuota: async (c, _u, q) => {
      st.log.push('bumpJobsUsedWithinQuota');
      if (st.jobsUsed >= q) return false;
      st.jobsUsed += 1;
      c.tx.undo.push(() => (st.jobsUsed -= 1));
      return true;
    },
    recordAllowanceDebit: async (c, uid, id, { trialSong }) => {
      st.log.push('recordAllowanceDebit');
      st.debits.set(id, { job_id: id, user_id: uid, period: 'P1', trial_song: trialSong });
      c.tx.undo.push(() => st.debits.delete(id));
      return true;
    },
    rollPeriodIfStale: async () => { st.log.push('rollPeriodIfStale'); },
    getEntitlementSnapshot: async () => { st.log.push('getEntitlementSnapshot'); return snap(); },
    enforceEntitlement: async () => { st.log.push('enforceEntitlement'); if (o.entRefusal) throw new EntitlementError(o.entRefusal); },
    consumeTrialInTx: async (c) => {
      st.log.push('consumeTrialInTx');
      if (!st.trial) return { ok: false, reason: 'no_grant' };
      if (st.trial.expired) return { ok: false, reason: 'expired' };
      if (st.trial.used >= st.trial.limit) return { ok: false, reason: 'exhausted' };
      st.trial.used += 1;
      c.tx.undo.push(() => (st.trial.used -= 1));
      return { ok: true, songs_remaining: st.trial.limit - st.trial.used, expires_at: 'x' };
    },
  };
  return { st, db, deps, o, nextId: () => `22222222-2222-4222-8222-${String(++seq).padStart(12, '0')}` };
}

// ── load the REAL route against the world ────────────────────────────────────────────────

const routeSrc = toJs(read('src/app/api/jobs/[id]/retry/route.ts'));
const retentionUrl = dataUrl(toJs(read('src/lib/retention.ts')));
const sameOriginUrl = dataUrl(toJs(read('src/lib/same-origin.ts')));
const youtubeUrl = dataUrl(toJs(read('src/lib/youtube-url.ts')));
const W = 'globalThis.__retryWorld';
const STUBS = {
  'next/server': dataUrl(`export class NextRequest {}
    export class NextResponse {
      constructor(b, i = {}) { this.status = i.status ?? 200; this.body = JSON.parse(b); this.headers = i.headers ?? {}; this.raw = true; }
      static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }`),
  crypto: dataUrl(`export const randomUUID = () => ${W}.nextId();`),
  '@sentry/nextjs': dataUrl(`export const captureException = (e) => { (${W}.st.captured ??= []).push(e); };`),
  '@/lib/db': dataUrl(`export const db = { query: (...a) => ${W}.db.query(...a), tx: (...a) => ${W}.db.tx(...a) };`),
  '@/lib/admission': dataUrl(`export const checkAdmission = (...a) => ${W}.deps.checkAdmission(...a);
    export const RATE_LIMIT = 5; export const RATE_WINDOW_MS = 60000;`),
  '@/lib/client-ip': dataUrl(`export const clientIpHashOf = () => 'iphash';`),
  '@/lib/youtube-url': youtubeUrl,
  '@/lib/auth/supabase': dataUrl(`export const getUser = (...a) => ${W}.deps.getUser(...a);`),
  '@/lib/error-copy': errorCopyUrl,
  '@/lib/billing/rate-limit': dataUrl(['checkBurstLimit', 'checkMonthlyQuota', 'bumpJobsUsed', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit', 'rollPeriodIfStale']
    .map((n) => `export const ${n} = (...a) => ${W}.deps.${n}(...a);`).join('\n')),
  '@/lib/billing/entitlements': dataUrl(`
    export class EntitlementError extends Error { constructor(code, message) { super(message ?? code); this.code = code; this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402; } }
    globalThis.__EntitlementError = EntitlementError;
    export const getEntitlementSnapshot = (...a) => ${W}.deps.getEntitlementSnapshot(...a);
    export const enforceEntitlement = async (...a) => { try { return await ${W}.deps.enforceEntitlement(...a); } catch (e) { if (e.code) throw new EntitlementError(e.code, e.message); throw e; } };
    export const FREE_QUOTA_EXHAUSTED_MESSAGE = 'FREE_MSG';`),
  '@/lib/trial': dataUrl(`export const consumeTrialInTx = (...a) => ${W}.deps.consumeTrialInTx(...a);`),
  '@/lib/same-origin': sameOriginUrl,
  '@/lib/retention': retentionUrl,
  '@/lib/jobs/create-link-job': LINK_JOB_URL,
  '@/lib/jobs/retry-policy': policyUrl,
};
function routeJs(src = routeSrc) {
  return src.replace(/from ['"]([^'"]+)['"]/g, (all, spec) => {
    if (!STUBS[spec]) throw new Error('unstubbed import in retry route: ' + spec);
    return `from '${STUBS[spec]}'`;
  });
}
const route = await import(dataUrl(routeJs()));

const reqOf = (origin = `https://${HOST}`) => ({
  headers: new Headers(origin ? { origin, host: HOST } : { host: HOST }),
  json: async () => ({}),
});
async function post(w, id = PARENT, origin) {
  globalThis.__retryWorld = w;
  return route.POST(reqOf(origin), { params: { id } });
}
async function get(w, id = PARENT) {
  globalThis.__retryWorld = w;
  return route.GET(reqOf(), { params: { id } });
}
const withYoutube = (fn) => async () => {
  const prev = process.env.ALLOW_YOUTUBE_INPUT;
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.ALLOW_YOUTUBE_INPUT; else process.env.ALLOW_YOUTUBE_INPUT = prev;
  }
};
const W0 = (o) => world(o);
const counts = (w) => ({
  jobs: w.st.jobs.size,
  jobsUsed: w.st.jobsUsed,
  songsUsed: w.st.trial ? w.st.trial.used : null,
  debits: w.st.debits.size - (w.st.debits.has(PARENT) ? 1 : 0),
  burst: w.st.burst,
});
const child = (w) => [...w.st.jobs.values()].find((j) => j.retry_of === PARENT);
const RESTORED = { restored_at: '2026-11-20T00:00:00Z', allowance_restored: true, trial_restored: false };

// ── AC1: which codes get the button (table) ──────────────────────────────────────────────

const failedLink = (over = {}) => ({
  user_id: USER, is_demo: false, input_kind: 'youtube', status: 'failed', error_code: 'FETCH_PROXY_FAILED',
  retry_depth: 0, retried_at: null, updated_at: '2026-11-22T00:00:00Z', ...over,
});
const NOW = Date.parse('2026-11-22T12:00:00Z');

test('AC1 table: #321\'s retryable codes are eligible; the never-retry and other codes are not', () => {
  const table = {
    DOWNLOAD_BLOCKED: 'eligible', DOWNLOAD_TIMEOUT: 'eligible', FETCH_PROXY_FAILED: 'eligible',
    SEPARATION_FAILED: 'eligible', UPLOAD_FAILED: 'eligible', INTERNAL_ERROR: 'eligible',
    DOWNLOAD_INVALID_URL: 'none', DOWNLOAD_PRIVATE: 'none', DOWNLOAD_AGE_RESTRICTED: 'none',
    EXTRACTION_FAILED: 'none', UPLOAD_INVALID: 'none', UPLOAD_TOO_LARGE: 'none', UPLOAD_TOO_LONG: 'none',
    AT_CAPACITY: 'none', toString: 'none', '': 'none',
  };
  for (const [code, kind] of Object.entries(table)) {
    assert.equal(policy.decideRetry(failedLink({ error_code: code }), USER, NOW).kind, kind, code);
  }
  assert.equal(policy.decideRetry(failedLink({ error_code: null }), USER, NOW).kind, 'none');
  assert.deepEqual([...policy.RETRYABLE_CODES].sort(), ['DOWNLOAD_BLOCKED', 'DOWNLOAD_TIMEOUT', 'FETCH_PROXY_FAILED', 'INTERNAL_ERROR', 'SEPARATION_FAILED', 'UPLOAD_FAILED']);
  for (const c of policy.NEVER_RETRY_CODES) assert.ok(!policy.RETRYABLE_CODES.includes(c), c);
});

test('AC1: RATE_LIMITED is retryable only after the cooldown', () => {
  const at = (s) => failedLink({ error_code: 'RATE_LIMITED', updated_at: new Date(NOW - s * 1000).toISOString() });
  assert.deepEqual(policy.decideRetry(at(10), USER, NOW), { kind: 'cooldown', retry_after_s: 50 });
  assert.equal(policy.decideRetry(at(59), USER, NOW).kind, 'cooldown');
  assert.deepEqual(policy.decideRetry(at(60), USER, NOW), { kind: 'eligible', retries_left: 2 });
});

test('AC1: an upload gets "Upload again", never a retry; a non-failed job gets nothing', () => {
  assert.equal(policy.decideRetry(failedLink({ input_kind: 'upload' }), USER, NOW).kind, 'upload_again');
  for (const status of ['queued', 'downloading', 'separating', 'extracting', 'uploading', 'done']) {
    assert.equal(policy.decideRetry(failedLink({ status }), USER, NOW).kind, 'none', status);
  }
});

test('AC3: owner only — another user, signed out, an anonymous job and a demo song are not found', () => {
  assert.equal(policy.decideRetry(failedLink(), OTHER, NOW).kind, 'not_found');
  assert.equal(policy.decideRetry(failedLink(), null, NOW).kind, 'not_found');
  assert.equal(policy.decideRetry(failedLink({ user_id: null }), USER, NOW).kind, 'not_found');
  assert.equal(policy.decideRetry(failedLink({ user_id: null }), null, NOW).kind, 'not_found');
  assert.equal(policy.decideRetry(failedLink({ user_id: undefined }), USER, NOW).kind, 'not_found');
  assert.equal(policy.decideRetry(failedLink({ is_demo: true }), USER, NOW).kind, 'not_found');
});

test('AC2 policy: the cap reads retry_depth (0,1 eligible; 2 capped) and retried_at refuses', () => {
  assert.deepEqual(policy.decideRetry(failedLink({ retry_depth: 0 }), USER, NOW), { kind: 'eligible', retries_left: 2 });
  assert.deepEqual(policy.decideRetry(failedLink({ retry_depth: 1 }), USER, NOW), { kind: 'eligible', retries_left: 1 });
  assert.equal(policy.decideRetry(failedLink({ retry_depth: 2 }), USER, NOW).kind, 'cap_reached');
  assert.equal(policy.decideRetry(failedLink({ retried_at: '2026-11-21T00:00:00Z' }), USER, NOW).kind, 'already_retried');
  assert.equal(policy.RETRY_CAP, 2);
});

test('charge rule: mirror the restore; only explicit true restores count', () => {
  const c = lib.mirrorRestoreCharge;
  assert.deepEqual(c(null), { unit: false, trialSong: false }, '(f) no debit row');
  assert.deepEqual(c({ restored_at: null, allowance_restored: null, trial_restored: null }), { unit: false, trialSong: false }, '(b) unclaimed (user fault)');
  assert.deepEqual(c({ restored_at: 'x', allowance_restored: false, trial_restored: false }), { unit: false, trialSong: false }, '(g)');
  assert.deepEqual(c({ restored_at: 'x', allowance_restored: true, trial_restored: false }), { unit: true, trialSong: false }, '(a)');
  assert.deepEqual(c({ restored_at: 'x', allowance_restored: false, trial_restored: true }), { unit: false, trialSong: true }, '(h1)');
  assert.deepEqual(c({ restored_at: 'x', allowance_restored: true, trial_restored: true }), { unit: true, trialSong: true }, '(h2)');
  assert.equal(policy.mirrorRestoreCharge, c);
});

// ── AC3 / AC8 through the route ───────────────────────────────────────────────────────────

test('AC3: cross-origin POST → 403 before anything is read', withYoutube(async () => {
  for (const origin of ['https://evil.example', null]) {
    const w = W0({ restore: RESTORED });
    const r = await post(w, PARENT, origin);
    assert.equal(r.status, 403);
    assert.equal(r.body.error_code, 'BAD_ORIGIN');
    assert.deepEqual(w.st.sql, []);
    assert.deepEqual(counts(w), { jobs: 1, jobsUsed: 0, songsUsed: null, debits: 0, burst: 0 });
  }
}));

test('AC3: non-owner, signed out, anonymous job, demo song → 404 on POST and GET; nothing written', withYoutube(async () => {
  for (const o of [{ user: OTHER }, { user: null }, { parent: { user_id: null } }, { parent: { is_demo: true } }]) {
    const w = W0({ restore: RESTORED, ...o });
    const r = await post(w);
    assert.equal(r.status, 404, JSON.stringify(o));
    assert.deepEqual(r.body, { error_code: 'NOT_FOUND', message: 'Job not found' });
    assert.deepEqual(counts(w), { jobs: 1, jobsUsed: 0, songsUsed: null, debits: 0, burst: 0 });
    assert.equal((await get(w)).status, 404, 'GET ' + JSON.stringify(o));
  }
  const bad = W0();
  assert.equal((await post(bad, 'not-a-uuid')).status, 404);
  assert.equal((await post(bad, '99999999-9999-4999-8999-999999999999')).status, 404);
}));

test('AC1 (route): an upload parent → 409 "Upload again", no job, original key never reused', withYoutube(async () => {
  const w = W0({ parent: { input_kind: 'upload', youtube_url: null, upload_r2_key: 'k/_input.mp3' } });
  const r = await post(w);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error_code: 'UPLOAD_AGAIN', message: copy.UPLOAD_AGAIN_MSG });
  assert.equal(w.st.jobs.size, 1);
  assert.ok(!w.st.log.includes('INSERT'));
  assert.equal((await get(w)).body.action, 'upload_again');
}));

test('AC1 (route): DOWNLOAD_PRIVATE / INVALID_URL / AGE_RESTRICTED → 409, no job', withYoutube(async () => {
  for (const code of policy.NEVER_RETRY_CODES) {
    const w = W0({ parent: { error_code: code } });
    const r = await post(w);
    assert.equal(r.status, 409, code);
    assert.equal(r.body.error_code, 'NOT_RETRYABLE');
    assert.equal(w.st.jobs.size, 1);
    assert.equal((await get(w)).body.action, 'none');
  }
}));

test('AC8: a retry goes through B0\'s gates — ALLOW_YOUTUBE_INPUT unset → 403; admission → 503 / 429', async () => {
  delete process.env.ALLOW_YOUTUBE_INPUT;
  const w = W0({ restore: RESTORED });
  const r = await post(w);
  assert.deepEqual([r.status, r.body.error_code], [403, 'DOWNLOAD_INVALID_URL']);
  assert.deepEqual(counts(w), { jobs: 1, jobsUsed: 0, songsUsed: null, debits: 0, burst: 0 });
  await withYoutube(async () => {
    const cap = W0({ admission: { allowed: false, error_code: 'AT_CAPACITY', message: 'busy', retry_after_s: 120 } });
    const r2 = await post(cap);
    assert.equal(r2.status, 503);
    assert.equal(r2.headers['Retry-After'], '120');
    assert.equal(cap.st.parentRetried, undefined);
    assert.equal(cap.st.jobs.get(PARENT).retried_at, null);
    const rl = W0({ admission: { allowed: false, error_code: 'RATE_LIMITED', message: 'slow' } });
    assert.equal((await post(rl)).status, 429);
    assert.deepEqual(counts(rl), { jobs: 1, jobsUsed: 0, songsUsed: null, debits: 0, burst: 0 });
  })();
});

// ── AC5: charge cases (row counts) ───────────────────────────────────────────────────────

test('(a) our-fault, allowance restored → 1 unit + 1 debit row; quota and burst checked', withYoutube(async () => {
  const w = W0({ restore: RESTORED, jobsUsed: 2 });
  const r = await post(w);
  assert.equal(r.status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 3, songsUsed: null, debits: 1, burst: 1 });
  const c = child(w);
  assert.deepEqual(r.body, { id: c.id, status: 'queued' });
  assert.deepEqual(w.st.debits.get(c.id), { job_id: c.id, user_id: USER, period: 'P1', trial_song: false });
  assert.deepEqual(w.st.log, ['enforceEntitlement', 'checkAdmission', 'getEntitlementSnapshot', 'checkBurstLimit', 'checkMonthlyQuota',
    'BEGIN', 'INSERT', 'rollPeriodIfStale', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit', 'MARK_RETRIED', 'COMMIT']);
}));

test('(a, paid) Pro: the unit is metered with bumpJobsUsed, as a paid link', withYoutube(async () => {
  const w = W0({ restore: RESTORED, plan: 'pro', jobsUsed: 40 });
  assert.equal((await post(w)).status, 201);
  assert.ok(w.st.log.includes('bumpJobsUsed') && !w.st.log.includes('bumpJobsUsedWithinQuota'));
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 41, songsUsed: null, debits: 1, burst: 1 });
}));

test('(b) DOWNLOAD_BLOCKED (not restored) → free: 0 units, 0 debit rows, no quota/trial/entitlement', withYoutube(async () => {
  const w = W0({ parent: { error_code: 'DOWNLOAD_BLOCKED' }, restore: { restored_at: null, allowance_restored: null, trial_restored: null }, trial: { used: 1, limit: 3 } });
  assert.equal((await post(w)).status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 0, songsUsed: 1, debits: 0, burst: 1 });
  assert.deepEqual(w.st.log, ['checkAdmission', 'checkBurstLimit', 'BEGIN', 'INSERT', 'rollPeriodIfStale', 'MARK_RETRIED', 'COMMIT']);
}));

test('(f) pre-042 parent: no debit row → free; (f2) database without 042 → free', withYoutube(async () => {
  const w = W0({ restore: null });
  assert.equal((await post(w)).status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 0, songsUsed: null, debits: 0, burst: 1 });
  const n = W0({ no042: true });
  assert.equal((await post(n)).status, 201);
  assert.deepEqual(counts(n), { jobs: 2, jobsUsed: 0, songsUsed: null, debits: 0, burst: 1 });
}));

test('(g) restored_at set but allowance_restored = false → free', withYoutube(async () => {
  const w = W0({ restore: { restored_at: '2026-11-01T00:00:00Z', allowance_restored: false, trial_restored: false }, jobsUsed: 5 });
  assert.equal((await post(w)).status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 5, songsUsed: null, debits: 0, burst: 1 });
  assert.ok(!w.st.log.includes('checkMonthlyQuota'));
}));

test('(h1) trial_restored only → 1 trial song, 0 units, a trial-only debit row (no period)', withYoutube(async () => {
  const w = W0({ restore: { restored_at: 'x', allowance_restored: false, trial_restored: true }, trial: { used: 1, limit: 3 }, jobsUsed: 2 });
  assert.equal((await post(w)).status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 2, songsUsed: 2, debits: 1, burst: 1 });
  assert.deepEqual(w.st.debits.get(child(w).id), { job_id: child(w).id, period: null, trial_song: true });
  assert.ok(!w.st.log.includes('checkMonthlyQuota'), 'no unit, no quota check');
}));

test('(h1x) trial_restored, trial since expired → free: no trial song, no unit, no debit row', withYoutube(async () => {
  const w = W0({ restore: { restored_at: 'x', allowance_restored: false, trial_restored: true }, trial: { used: 1, limit: 3, expired: true } });
  assert.equal((await post(w)).status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 0, songsUsed: 1, debits: 0, burst: 1 });
}));

test('(h1, exhausted) the given-back trial song was spent since → existing TRIAL_EXHAUSTED copy, nothing written', withYoutube(async () => {
  const w = W0({ restore: { restored_at: 'x', allowance_restored: false, trial_restored: true }, trial: { used: 3, limit: 3 } });
  const r = await post(w);
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, { error_code: 'TRIAL_EXHAUSTED', message: copy.entitlementMessage('TRIAL_EXHAUSTED') });
  assert.deepEqual(counts(w), { jobs: 1, jobsUsed: 0, songsUsed: 3, debits: 0, burst: 1 });
  assert.equal(w.st.jobs.get(PARENT).retried_at, null);
}));

test('(h2) both restored → 1 trial song + 1 unit, one debit row with trial_song', withYoutube(async () => {
  const w = W0({ restore: { restored_at: 'x', allowance_restored: true, trial_restored: true }, trial: { used: 0, limit: 3 }, jobsUsed: 1 });
  assert.equal((await post(w)).status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 2, songsUsed: 1, debits: 1, burst: 1 });
  assert.equal(w.st.debits.get(child(w).id).trial_song, true);
  assert.equal(w.st.debits.get(child(w).id).period, 'P1');
}));

test('(j) (a) for a Free user now at quota → existing quota copy, 0 jobs, 0 debits, only the burst row', withYoutube(async () => {
  const w = W0({ restore: RESTORED, jobsUsed: 5 });
  const r = await post(w);
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, { error: 'monthly quota reached', code: 'quota_exceeded', resets_at: '2026-12-01T00:00:00Z' });
  assert.deepEqual(counts(w), { jobs: 1, jobsUsed: 5, songsUsed: null, debits: 0, burst: 1 });
  assert.equal(w.st.jobs.get(PARENT).retried_at, null);
}));

test('(k) a free retry at quota → allowed (no quota check); the burst limit still applies', withYoutube(async () => {
  const w = W0({ restore: null, jobsUsed: 5 });
  assert.equal((await post(w)).status, 201);
  assert.deepEqual(counts(w), { jobs: 2, jobsUsed: 5, songsUsed: null, debits: 0, burst: 1 });
  assert.ok(!w.st.log.includes('checkMonthlyQuota') && !w.st.log.includes('enforceEntitlement'));
  const b = W0({ restore: null, jobsUsed: 5, burst: { retry_after_s: 60 } });
  const r = await post(b);
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error: 'too many requests', code: 'rate_limit_burst', retry_after_s: 60 });
  assert.equal(b.st.jobs.size, 1);
  assert.equal(b.st.jobs.get(PARENT).retried_at, null);
}));

test('(i) a free retry that fails our-fault gives nothing back, so the next retry is free too', withYoutube(async () => {
  const w = W0({ restore: null });
  assert.equal((await post(w)).status, 201);
  const first = child(w);
  first.status = 'failed';
  first.error_code = 'INTERNAL_ERROR';
  first.updated_at = new Date(Date.now() - 3600_000).toISOString();
  // the worker's restore claims nothing: no debit row exists for a free retry
  assert.equal(w.st.debits.has(first.id), false);
  const r = await post(w, first.id);
  assert.equal(r.status, 201);
  assert.deepEqual({ jobsUsed: w.st.jobsUsed, debits: w.st.debits.size }, { jobsUsed: 0, debits: 0 });
}));

// ── AC2: the cap ─────────────────────────────────────────────────────────────────────────

test('AC2: retries 1 and 2 succeed (depth 1, 2, chained to the original), the 3rd → 429, button hidden', withYoutube(async () => {
  const w = W0({ restore: null });
  const r1 = await post(w);
  assert.equal(r1.status, 201);
  const c1 = w.st.jobs.get(r1.body.id);
  assert.deepEqual([c1.retry_of, c1.retry_depth], [PARENT, 1]);
  Object.assign(c1, { status: 'failed', error_code: 'SEPARATION_FAILED' });
  const r2 = await post(w, c1.id);
  assert.equal(r2.status, 201);
  const c2 = w.st.jobs.get(r2.body.id);
  assert.deepEqual([c2.retry_of, c2.retry_depth], [c1.id, 2]);
  Object.assign(c2, { status: 'failed', error_code: 'SEPARATION_FAILED' });
  const r3 = await post(w, c2.id);
  assert.equal(r3.status, 429);
  assert.deepEqual(r3.body, { error_code: 'RETRY_LIMIT', message: copy.RETRY_LIMIT_MSG });
  assert.equal(w.st.jobs.size, 3);
  assert.equal((await get(w, c2.id)).body.action, 'cap_reached');
  assert.deepEqual([...w.st.jobs.values()].map((j) => j.retry_depth).sort(), [0, 1, 2]);
}));

test('AC2: the lib refuses depth 2 under the lock even when the route\'s check is bypassed', withYoutube(async () => {
  const w = W0({ parent: { retry_depth: 2 } });
  globalThis.__retryWorld = w;
  const r = await lib.createAuthedLinkJob(
    { user: { user_id: USER }, url: CANON, clientIpHash: () => 'iphash', funding: { mode: 'mirror_restore', parentJobId: PARENT, limitMessage: 'LIMIT' } },
    libDeps(w),
  );
  assert.deepEqual(r, { status: 429, body: { error_code: 'RETRY_LIMIT', message: 'LIMIT' } });
  assert.equal(w.st.jobs.size, 1);
  const ok = W0({ parent: { retry_depth: 1 } });
  const r1 = await lib.createAuthedLinkJob(
    { user: { user_id: USER }, url: CANON, clientIpHash: () => 'iphash', funding: { mode: 'mirror_restore', parentJobId: PARENT, limitMessage: 'LIMIT' } },
    libDeps(ok),
  );
  assert.equal(r1.status, 201);
  assert.equal(child(ok).retry_depth, 2);
}));

test('AC3: under the lock the lib re-checks owner, failed and link — 404, nothing written', withYoutube(async () => {
  for (const parent of [{ user_id: OTHER }, { user_id: null }, { status: 'queued' }, { status: 'done' }, { input_kind: 'upload' }]) {
    const w = W0({ parent, restore: RESTORED });
    const r = await lib.createAuthedLinkJob(
      { user: { user_id: USER }, url: CANON, clientIpHash: () => 'iphash', funding: { mode: 'mirror_restore', parentJobId: PARENT, limitMessage: 'LIMIT' } },
      libDeps(w),
    );
    assert.deepEqual(r, { status: 404, body: { error_code: 'NOT_FOUND', message: 'Job not found' } }, JSON.stringify(parent));
    assert.deepEqual({ jobs: w.st.jobs.size, jobsUsed: w.st.jobsUsed, retried: w.st.jobs.get(PARENT).retried_at }, { jobs: 1, jobsUsed: 0, retried: null });
  }
}));

test('AC2: root swept → retrying the newest (depth 2, retry_of NULL) is still refused', withYoutube(async () => {
  const w = W0({ parent: { retry_depth: 2, retry_of: null } });
  const r = await post(w);
  assert.equal(r.status, 429);
  assert.equal(w.st.jobs.size, 1);
  // ...also when the route's own check is skipped (the lib's cap reads retry_depth, not a chain)
  const r2 = await lib.createAuthedLinkJob(
    { user: { user_id: USER }, url: CANON, clientIpHash: () => 'iphash', funding: { mode: 'mirror_restore', parentJobId: PARENT, limitMessage: 'LIMIT' } },
    libDeps(w),
  );
  assert.equal(r2.status, 429);
}));

test('AC2: a depth-1 job whose parent was swept retries once, to depth 2', withYoutube(async () => {
  const w = W0({ parent: { retry_depth: 1, retry_of: null } });
  const r = await post(w);
  assert.equal(r.status, 201);
  assert.equal(w.st.jobs.get(r.body.id).retry_depth, 2);
}));

test('AC2: a parent with retried_at set is refused even after its retry was swept', withYoutube(async () => {
  const w = W0({ parent: { retried_at: '2026-11-21T00:00:00Z' } });
  const r = await post(w);
  assert.deepEqual([r.status, r.body.error_code], [429, 'RETRY_LIMIT']);
  assert.equal(w.st.jobs.size, 1);
  const g = await get(w);
  assert.deepEqual(g.body, { action: 'already_retried', retry_of: null, retried_by: null });
  // and the lib alone refuses it too (under the lock)
  const r2 = await lib.createAuthedLinkJob(
    { user: { user_id: USER }, url: CANON, clientIpHash: () => 'iphash', funding: { mode: 'mirror_restore', parentJobId: PARENT, limitMessage: 'LIMIT' } },
    libDeps(w),
  );
  assert.equal(r2.status, 429);
}));

test('AC2: a second tap on the same parent (sequential) → 200 with the first retry, nothing charged twice', withYoutube(async () => {
  const w = W0({ restore: RESTORED });
  const one = await post(w);
  assert.equal(one.status, 201);
  const mid = counts(w);
  const two = await post(w);
  assert.deepEqual(two.body, { id: one.body.id });
  assert.equal(two.status, 200);
  assert.deepEqual(counts(w), mid);
}));

// ── AC4: concurrency (the fake's row lock; the real one is in job-retry-pg) ───────────────

for (const [name, o] of [['free', { restore: null }], ['charged', { restore: RESTORED, jobsUsed: 1 }], ['trial', { restore: { restored_at: 'x', allowance_restored: true, trial_restored: true }, trial: { used: 0, limit: 3 } }]]) {
  test(`AC4 (${name}): two concurrent POSTs on one parent → 1 job, ≤ 1 debit, same id`, withYoutube(async () => {
    const w = W0(o);
    globalThis.__retryWorld = w;
    const [a, b] = await Promise.all([route.POST(reqOf(), { params: { id: PARENT } }), route.POST(reqOf(), { params: { id: PARENT } })]);
    assert.equal(w.st.jobs.size, 2, 'exactly one retry job');
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.id, b.body.id);
    assert.ok(counts(w).debits <= 1);
    if (name === 'charged') assert.equal(w.st.jobsUsed, 2, 'one unit');
    if (name === 'trial') assert.deepEqual([w.st.trial.used, w.st.jobsUsed], [1, 1], 'one song, one unit');
  }));
}

// ── AC6: C-1 and no breaker ──────────────────────────────────────────────────────────────

test('AC6 / C-1: a per-IP 429 retry leaves retried_at NULL, no job, and the button still offered', withYoutube(async () => {
  for (const o of [{ restore: null }, { restore: RESTORED }, { restore: { restored_at: 'x', allowance_restored: true, trial_restored: true }, trial: { used: 0, limit: 3 } }]) {
    const w = W0({ ...o, ipFull: true });
    const r = await post(w);
    assert.equal(r.status, 429, JSON.stringify(o));
    assert.equal(r.body.error_code, 'RATE_LIMITED');
    assert.equal(w.st.jobs.get(PARENT).retried_at, null, 'retried_at stays NULL');
    assert.equal(w.st.jobs.size, 1);
    assert.deepEqual({ jobsUsed: w.st.jobsUsed, debits: counts(w).debits }, { jobsUsed: o.restore === RESTORED ? 0 : 0, debits: 0 });
    if (w.st.trial) assert.equal(w.st.trial.used, 0, 'the trial song is not burned');
    assert.equal((await get(w)).body.action, 'eligible', 'the button is still shown');
  }
}));

test('AC6: no outage breaker — nothing in B3 reads a health / canary / fetch signal', () => {
  const strip = (s) => toJs(s).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['src/app/api/jobs/[id]/retry/route.ts', 'src/lib/jobs/retry-policy.ts']) {
    const code = strip(read(f));
    assert.doesNotMatch(code, /canary|\/health|fetch_canary|kill_switch|breaker|outage/i, f);
  }
  const jv = strip(read('src/app/jobs/[id]/JobView.tsx'));
  assert.doesNotMatch(jv, /canary|\/health|breaker/i);
});

// ── AC7: the original stays a record; attempts untouched ─────────────────────────────────

test('AC7: the original stays failed with its attempts; the retry starts at attempts 0, retry_of = original', withYoutube(async () => {
  const w = W0({ restore: RESTORED });
  const r = await post(w);
  const p = w.st.jobs.get(PARENT);
  assert.deepEqual([p.status, p.error_code, p.attempts], ['failed', 'FETCH_PROXY_FAILED', 1]);
  assert.ok(p.retried_at);
  const c = w.st.jobs.get(r.body.id);
  assert.deepEqual([c.status, c.attempts, c.retry_of, c.retry_depth, c.youtube_url], ['queued', 0, PARENT, 1, CANON]);
  assert.deepEqual(c.requested_stems, ['drums', 'bass'], 'the parent\'s stems carry over');
  const g = await get(w, c.id);
  assert.equal(g.body.retry_of, PARENT, 'the retry\'s page can link "Retry of" its original');
}));

test('GET: eligible carries what it costs (free / charged) and how many tries are left', withYoutube(async () => {
  assert.deepEqual((await get(W0({ restore: RESTORED }))).body, { action: 'eligible', retry_of: null, retries_left: 2, charge: 'charged' });
  assert.deepEqual((await get(W0({ restore: null }))).body, { action: 'eligible', retry_of: null, retries_left: 2, charge: 'free' });
  const g = await get(W0({ parent: { error_code: 'RATE_LIMITED', updated_at: new Date().toISOString() } }));
  assert.equal(g.body.action, 'cooldown');
  assert.ok(g.body.retry_after_s > 0);
}));

// ── B0 unchanged: funding absent → no B3 SQL at all ──────────────────────────────────────

test('without `funding` the lib never touches the B3 SQL (B0 behaviour, byte-for-byte path)', withYoutube(async () => {
  const w = W0({});
  const seen = [];
  const deps = libDeps(w);
  const q = w.db.tx;
  deps.db = {
    query: async (s) => { seen.push(s); throw new Error('no lock-free read in B0'); },
    tx: (fn) => q(async (c) => fn({ tx: c.tx, query: async (s, p) => { seen.push(s); if (/^INSERT INTO jobs/.test(s.trim())) return { rows: [{ id: p[0] }], rowCount: 1 }; return c.query(s, p); } })),
  };
  const r = await lib.createAuthedLinkJob({ user: { user_id: USER }, url: CANON, clientIpHash: () => 'iphash' }, deps);
  assert.equal(r.status, 201);
  assert.ok(seen.every((s) => !/retry_of|retried_at|FOR UPDATE|job_allowance_debits/.test(s)), seen.join('\n'));
}));

function libDeps(w) {
  globalThis.__retryWorld = w;
  return {
    db: w.db,
    randomUUID: () => w.nextId(),
    canonicalizeYoutubeUrl: (u) => u,
    checkAdmission: w.deps.checkAdmission,
    RATE_LIMIT: 5,
    RATE_WINDOW_MS: 60000,
    checkBurstLimit: w.deps.checkBurstLimit,
    checkMonthlyQuota: w.deps.checkMonthlyQuota,
    bumpJobsUsed: w.deps.bumpJobsUsed,
    bumpJobsUsedWithinQuota: w.deps.bumpJobsUsedWithinQuota,
    recordAllowanceDebit: w.deps.recordAllowanceDebit,
    rollPeriodIfStale: w.deps.rollPeriodIfStale,
    getEntitlementSnapshot: w.deps.getEntitlementSnapshot,
    enforceEntitlement: w.deps.enforceEntitlement,
    EntitlementError,
    FREE_QUOTA_EXHAUSTED_MESSAGE: 'FREE_MSG',
    LINK_CAP_CREDITS_DETAIL: 'CREDITS',
    RATE_LIMIT_MSG: 'RATE_MSG',
    entitlementMessage: (c) => `copy(${c})`,
    consumeTrialInTx: w.deps.consumeTrialInTx,
    captureException: () => {},
    noteAllowanceDebitRecorded: () => {},
  };
}

// ── the route walks: same-origin and no new labels on the 042 copy ───────────────────────

test('the retry route calls crossOriginRefusal first in POST, and GET writes nothing', () => {
  const src = read('src/app/api/jobs/[id]/retry/route.ts');
  const postBody = src.slice(src.indexOf('export async function POST'));
  const first = postBody.indexOf('crossOriginRefusal(request)');
  assert.ok(first > 0 && first < postBody.indexOf('getUser()') && first < postBody.indexOf('readJob(') && first < postBody.indexOf('createAuthedLinkJob('), 'same-origin is the first check');
  const getBody = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
  assert.doesNotMatch(getBody, /createAuthedLinkJob|INSERT|UPDATE/);
});

test('migration 045: columns, cap CHECK 0..2, SET NULL FK, down file, header with apply + verify', () => {
  const up = readFileSync(join(REPO, 'apps/worker/migrations/045_v3_jobs_retry_of.sql'), 'utf8');
  const code = up.replace(/--.*$/gm, '');
  assert.match(code, /ADD COLUMN IF NOT EXISTS retry_of uuid NULL\s+CONSTRAINT jobs_retry_of_fkey REFERENCES public\.jobs\(id\) ON DELETE SET NULL/);
  assert.match(code, /ADD COLUMN IF NOT EXISTS retry_depth smallint NOT NULL DEFAULT 0\s+CONSTRAINT jobs_retry_depth_range CHECK \(retry_depth BETWEEN 0 AND 2\)/);
  assert.match(code, /ADD COLUMN IF NOT EXISTS retried_at timestamptz NULL/);
  assert.match(code, /CREATE INDEX IF NOT EXISTS jobs_retry_of_idx/);
  assert.doesNotMatch(code, /attempts/, 'jobs.attempts is never reused');
  assert.match(up, /INSERT INTO public\._migrations\(filename\) VALUES \('045_v3_jobs_retry_of\.sql'\)/);
  assert.match(up, /DEPLOY ORDER: Jon applies 045 -> merge -> web deploys/);
  const down = readFileSync(join(REPO, 'apps/worker/migrations/down/045_v3_jobs_retry_of_down.sql'), 'utf8');
  for (const c of ['retried_at', 'retry_depth', 'retry_of']) assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${c}`));
  assert.match(down, /DELETE FROM public\._migrations WHERE filename = '045_v3_jobs_retry_of\.sql'/);
});

test('the copy: one-sentence lines, no code-shaped tokens, no credit/refund wording', () => {
  for (const k of ['RETRY_BUTTON_LABEL', 'RETRY_COST_FREE', 'RETRY_COST_CHARGED', 'RETRY_LIMIT_MSG', 'RETRY_ALREADY_MSG', 'UPLOAD_AGAIN_LABEL', 'UPLOAD_AGAIN_MSG', 'RETRY_COOLDOWN_MSG']) {
    const s = copy[k];
    assert.equal(typeof s, 'string', k);
    assert.doesNotMatch(s, /[A-Z]{2,}_[A-Z]|credit|refund/i, k);
  }
  assert.notEqual(copy.RETRY_BUTTON_LABEL, 'Try again', 'distinct from the poll panel button');
});

void statSync; void readdirSync; void relative;
