// Phase B B3 (#321) against a REAL Postgres: POST /api/jobs/:id/retry end to end, with the
// REAL route, the REAL lib (create-link-job.ts, funding mode mirror_restore), the REAL
// rate-limit.ts (burst, quota lock, bumps, recordAllowanceDebit), the REAL trial.ts, and
// migration 042's REAL restore_job_allowance() producing every parent's restore state. Only
// auth (getUser), the client IP, admission's pre-check, the entitlement snapshot (read straight
// from entitlements + plans), Sentry and next/server are stubbed.
//
// What only a real database proves (the B0 reviewer carry-over): two concurrent retries of one
// parent, on two connections, both passing every lock-free gate and racing to the parent's
// FOR UPDATE → exactly 1 job and at most 1 debit. Plus the charge cases as ROW COUNTS in
// job_allowance_debits, entitlements.jobs_used and trial_grants.songs_used; migration 045's
// CHECK (retry_depth 0..2) and ON DELETE SET NULL; and C-1 (a per-IP 429 leaves retried_at NULL).
//
// Skips locally without a local DATABASE_URL; FAILS under CI=true (a skipped gate is not a
// pass). Never point it at a shared database: it INSERTs into auth.users.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LINK_JOB_URL } from './helpers/create-link-job.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(WEB, 'package.json'));
const read = (rel) => readFileSync(join(WEB, rel), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const DB_URL = process.env.DATABASE_URL;
let skip = false;
if (!DB_URL) skip = 'DATABASE_URL not set';
else {
  const host = new URL(DB_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', ''].includes(host)) skip = `DATABASE_URL host ${host} is not local`;
}
if (skip && process.env.CI) throw new Error(`CI=true but ${skip}`);

let pool;
if (!skip) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, max: 12 });
  globalThis.__retryPool = pool;
}

const P = 'globalThis.__retryPool';
const dbStub = dataUrl(`
  export const db = {
    query: (t, p) => ${P}.query(t, p),
    tx: async (fn) => { const c = await ${P}.connect();
      // Test hook: globalThis.__retryOnQuery(sql, run) may hold a statement (the concurrency
      // barrier) before it reaches Postgres. Absent, the client is passed through untouched.
      const client = globalThis.__retryOnQuery
        ? { query: (t, p) => globalThis.__retryOnQuery(String(t), p, () => c.query(t, p)) }
        : c;
      try { await c.query('BEGIN'); const r = await fn(client); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } },
  };`);
const entStub = dataUrl(`
  export class EntitlementError extends Error {
    constructor(code, message) { super(message ?? code); this.name = 'EntitlementError'; this.code = code;
      this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402; } }
  export const FREE_QUOTA_EXHAUSTED_MESSAGE = "You've used all your free tracks this month.";
  export const isPeriodStale = (pe) => !pe || new Date(pe).getTime() <= Date.now();
  export async function getEntitlementSnapshot(uid) {
    const r = await ${P}.query(
      'SELECT e.plan_code, e.jobs_used, e.period_end, p.monthly_job_quota FROM public.entitlements e JOIN public.plans p ON p.code = e.plan_code WHERE e.user_id = $1', [uid]);
    const row = r.rows[0];
    return { plan_code: row?.plan_code ?? 'free', jobs_quota: row?.monthly_job_quota ?? 0, jobs_used: row?.jobs_used ?? 0,
             period_end: row?.period_end ? new Date(row.period_end).toISOString() : null, credits_remaining: 0 };
  }
  export async function enforceEntitlement() {}`);
const rateUrl = dataUrl(
  toJs(read('src/lib/billing/rate-limit.ts'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]\.\/entitlements['"]/g, `from '${entStub}'`),
);
const trialUrl = dataUrl(toJs(read('src/lib/trial.ts')).replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`));
const errorCopyUrl = dataUrl(toJs(read('src/lib/error-copy.ts')));
const policyUrl = dataUrl(
  toJs(read('src/lib/jobs/retry-policy.ts')).replace(/from ['"]@\/lib\/jobs\/create-link-job['"]/g, `from '${LINK_JOB_URL}'`),
);
const STUBS = {
  'next/server': dataUrl(`export class NextRequest {}
    export class NextResponse {
      constructor(b, i = {}) { this.status = i.status ?? 200; this.body = JSON.parse(b); this.headers = i.headers ?? {}; }
      static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }`),
  '@sentry/nextjs': dataUrl('export const captureException = (e) => { (globalThis.__retryCaptured ??= []).push(e); };'),
  '@/lib/db': dbStub,
  '@/lib/admission': dataUrl(`export const checkAdmission = async () => globalThis.__retryAdmission ?? { allowed: true, error_code: null };
    export const RATE_LIMIT = 5; export const RATE_WINDOW_MS = 60000;`),
  '@/lib/client-ip': dataUrl('export const clientIpHashOf = () => globalThis.__retryIp;'),
  '@/lib/youtube-url': dataUrl(toJs(read('src/lib/youtube-url.ts'))),
  '@/lib/auth/supabase': dataUrl('export const getUser = async () => globalThis.__retryUser;'),
  '@/lib/error-copy': errorCopyUrl,
  '@/lib/billing/rate-limit': rateUrl,
  '@/lib/billing/entitlements': entStub,
  '@/lib/trial': trialUrl,
  '@/lib/same-origin': dataUrl(toJs(read('src/lib/same-origin.ts'))),
  '@/lib/retention': dataUrl(toJs(read('src/lib/retention.ts'))),
  '@/lib/jobs/create-link-job': LINK_JOB_URL,
  '@/lib/jobs/retry-policy': policyUrl,
};
const routeJs = toJs(read('src/app/api/jobs/[id]/retry/route.ts')).replace(/from ['"]([^'"]+)['"]/g, (all, spec) => {
  if (spec === 'crypto') return all;
  if (!STUBS[spec]) throw new Error('unstubbed import: ' + spec);
  return `from '${STUBS[spec]}'`;
});
const route = await import(dataUrl(routeJs));
const rate = await import(rateUrl);

const EMAIL_PREFIX = 'test-web-job-retry-';
const IP_PREFIX = 'b3-retry-';
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OUR_FAULT = ['SEPARATION_FAILED', 'UPLOAD_FAILED', 'INTERNAL_ERROR', 'FETCH_PROXY_FAILED'];
const HOST = 'stem-loops.com';

async function cleanup() {
  const like = `(SELECT id FROM public.users WHERE email LIKE '${EMAIL_PREFIX}%')`;
  await pool.query(`DELETE FROM public.jobs WHERE user_id IN ${like} OR client_ip_hash LIKE '${IP_PREFIX}%'`);
  await pool.query(`DELETE FROM public.usage_events WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'`);
}
after(async () => {
  if (pool) {
    await cleanup();
    await pool.end();
  }
});

async function mkUser({ trial = false } = {}) {
  const uid = randomUUID();
  await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [uid, `${EMAIL_PREFIX}${uid.slice(0, 8)}@example.test`]);
  if (trial) await pool.query('INSERT INTO public.trial_grants (user_id) VALUES ($1)', [uid]);
  globalThis.__retryUser = { user_id: uid };
  globalThis.__retryIp = IP_PREFIX + uid.slice(0, 12);
  globalThis.__retryAdmission = undefined;
  return uid;
}

/**
 * A failed link job the way production makes one: the web's INSERT + spend + debit record
 * (spend 'none' | 'unit' | 'trial'), then failed with `code`, then the worker's REAL
 * restore_job_allowance(). `rollPeriod`: move the period between the spend and the restore,
 * so the allowance unit is NOT given back (restored_at set, allowance_restored = false).
 */
async function failedParent(uid, { code = 'FETCH_PROXY_FAILED', spend = 'unit', rollPeriod = false, depth = 0, retryOf = null, kind = 'youtube', restore = true } = {}) {
  const jid = randomUUID();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      kind === 'youtube'
        ? `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint, user_id, retry_depth, retry_of)
           VALUES ($1, '${CANON}', ARRAY['drums','bass'], 4, 'queued', 'b3-seed', '', $2, $3, $4)`
        : `INSERT INTO jobs (id, input_kind, upload_r2_key, original_filename, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint, user_id, retry_depth, retry_of)
           VALUES ($1, 'upload', $5, 'take.mp3', ARRAY['drums'], 4, 'queued', 'b3-seed', '', $2, $3, $4)`,
      kind === 'youtube' ? [jid, uid, depth, retryOf] : [jid, uid, depth, retryOf, `${jid}/_input.mp3`],
    );
    if (spend === 'trial') await c.query('UPDATE public.trial_grants SET songs_used = songs_used + 1 WHERE user_id = $1', [uid]);
    if (spend !== 'none') {
      await rate.rollPeriodIfStale(c, uid);
      await rate.bumpJobsUsed(c, uid);
      assert.equal(await rate.recordAllowanceDebit(c, uid, jid, { trialSong: spend === 'trial' }), true);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  await pool.query(`UPDATE jobs SET status = 'failed', error_code = $2, attempts = 1 WHERE id = $1`, [jid, code]);
  if (rollPeriod) await pool.query(`UPDATE public.entitlements SET period_start = period_start - interval '1 day' WHERE user_id = $1`, [uid]);
  if (restore) await pool.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [jid, OUR_FAULT]);
  if (rollPeriod) await pool.query(`UPDATE public.entitlements SET period_start = period_start + interval '1 day' WHERE user_id = $1`, [uid]);
  return jid;
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
async function rowCounts(uid, parent) {
  const r = await one(
    `SELECT (SELECT count(*)::int FROM jobs WHERE user_id = $1) AS jobs,
            (SELECT jobs_used FROM public.entitlements WHERE user_id = $1) AS jobs_used,
            (SELECT songs_used FROM public.trial_grants WHERE user_id = $1) AS songs_used,
            (SELECT count(*)::int FROM public.job_allowance_debits WHERE user_id = $1 AND job_id <> $2) AS debits,
            (SELECT count(*)::int FROM public.usage_events WHERE user_id = $1 AND kind = 'job_start_attempt') AS burst`,
    [uid, parent],
  );
  return r;
}
const restoreOf = (jid) => one('SELECT restored_at IS NOT NULL AS claimed, allowance_restored, trial_restored FROM public.job_allowance_debits WHERE job_id = $1', [jid]);
const jobRow = (jid) => one('SELECT status, error_code, attempts, retry_of, retry_depth, retried_at FROM jobs WHERE id = $1', [jid]);
const reqOf = () => ({ headers: new Headers({ origin: `https://${HOST}`, host: HOST }), json: async () => ({}) });
const post = (id) => route.POST(reqOf(), { params: { id } });
const get = (id) => route.GET(reqOf(), { params: { id } });
const withYoutube = (fn) => async () => {
  const prev = process.env.ALLOW_YOUTUBE_INPUT;
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.ALLOW_YOUTUBE_INPUT; else process.env.ALLOW_YOUTUBE_INPUT = prev;
  }
};
const T = (name, fn) => test(name, { skip }, withYoutube(fn));
const freeQuota = async () => (await one(`SELECT monthly_job_quota FROM public.plans WHERE code = 'free'`)).monthly_job_quota;
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] === null ? null : b[k] - a[k]]));

// ── migration 045 itself ─────────────────────────────────────────────────────────────────

T('045: retry_depth CHECK refuses 3 and -1; retry_of is ON DELETE SET NULL', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'none' });
  for (const d of [3, -1]) {
    await assert.rejects(pool.query('UPDATE jobs SET retry_depth = $2 WHERE id = $1', [p, d]), (e) => e.code === '23514', String(d));
  }
  const c = await failedParent(uid, { spend: 'none', retryOf: p, depth: 1 });
  await pool.query('DELETE FROM jobs WHERE id = $1', [p]);
  assert.deepEqual(await one('SELECT retry_of, retry_depth FROM jobs WHERE id = $1', [c]), { retry_of: null, retry_depth: 1 });
});

// ── AC5: the charge cases, as row counts ─────────────────────────────────────────────────

T('(a) our-fault, allowance restored → +1 job, +1 jobs_used, +1 debit row (period set), +1 burst', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'FETCH_PROXY_FAILED' });
  assert.deepEqual(await restoreOf(p), { claimed: true, allowance_restored: true, trial_restored: false });
  const before = await rowCounts(uid, p);
  const r = await post(p);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 1, songs_used: null, debits: 1, burst: 1 });
  const d = await one('SELECT trial_song, allowance_period_start IS NOT NULL AS has_period FROM public.job_allowance_debits WHERE job_id = $1', [r.body.id]);
  assert.deepEqual(d, { trial_song: false, has_period: true });
});

T('(b) DOWNLOAD_BLOCKED (user fault, row unclaimed) → free: +1 job, 0 jobs_used, 0 debits', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'DOWNLOAD_BLOCKED' });
  assert.deepEqual(await restoreOf(p), { claimed: false, allowance_restored: null, trial_restored: null });
  const before = await rowCounts(uid, p);
  assert.equal((await post(p)).status, 201);
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 0, burst: 1 });
});

T('(f) pre-042 parent with no debit row → free', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'none', code: 'INTERNAL_ERROR' });
  const before = await rowCounts(uid, p);
  assert.equal((await post(p)).status, 201);
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 0, burst: 1 });
});

T('(g) restored_at set, allowance_restored = false (period moved) → free', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'SEPARATION_FAILED', rollPeriod: true });
  assert.deepEqual(await restoreOf(p), { claimed: true, allowance_restored: false, trial_restored: false });
  const before = await rowCounts(uid, p);
  assert.equal((await post(p)).status, 201);
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 0, burst: 1 });
});

T('(h1) trial_restored only → +1 songs_used, 0 jobs_used, one trial-only debit row (no period)', async () => {
  const uid = await mkUser({ trial: true });
  const p = await failedParent(uid, { spend: 'trial', code: 'INTERNAL_ERROR', rollPeriod: true });
  assert.deepEqual(await restoreOf(p), { claimed: true, allowance_restored: false, trial_restored: true });
  const before = await rowCounts(uid, p);
  const r = await post(p);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: 1, debits: 1, burst: 1 });
  assert.deepEqual(
    await one('SELECT trial_song, allowance_period_start FROM public.job_allowance_debits WHERE job_id = $1', [r.body.id]),
    { trial_song: true, allowance_period_start: null },
  );
});

T('(h1x) trial_restored, trial since expired → free: 0 songs_used, 0 jobs_used, 0 debits', async () => {
  const uid = await mkUser({ trial: true });
  const p = await failedParent(uid, { spend: 'trial', code: 'INTERNAL_ERROR', rollPeriod: true });
  await pool.query(`UPDATE public.trial_grants SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [uid]);
  assert.equal((await get(p)).body.charge, 'free', 'GET says free for an expired trial (review R1)');
  const before = await rowCounts(uid, p);
  assert.equal((await post(p)).status, 201);
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: 0, debits: 0, burst: 1 });
});

T('(h2) both restored → +1 songs_used and +1 jobs_used, one debit row with trial_song', async () => {
  const uid = await mkUser({ trial: true });
  const p = await failedParent(uid, { spend: 'trial', code: 'FETCH_PROXY_FAILED' });
  assert.deepEqual(await restoreOf(p), { claimed: true, allowance_restored: true, trial_restored: true });
  const before = await rowCounts(uid, p);
  const r = await post(p);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 1, songs_used: 1, debits: 1, burst: 1 });
  assert.equal((await one('SELECT trial_song FROM public.job_allowance_debits WHERE job_id = $1', [r.body.id])).trial_song, true);
});

T('(j) (a) for a Free user now at quota → 402 quota copy, 0 jobs, 0 debits, only the burst row', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'FETCH_PROXY_FAILED' });
  await pool.query('UPDATE public.entitlements SET jobs_used = $2 WHERE user_id = $1', [uid, await freeQuota()]);
  const before = await rowCounts(uid, p);
  const r = await post(p);
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'quota_exceeded');
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 0, jobs_used: 0, songs_used: null, debits: 0, burst: 1 });
  assert.equal((await jobRow(p)).retried_at, null);
});

T('(k) a free retry at quota → allowed, no quota check; burst still recorded', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'none', code: 'FETCH_PROXY_FAILED' });
  await pool.query('UPDATE public.entitlements SET jobs_used = $2 WHERE user_id = $1', [uid, await freeQuota()]);
  const before = await rowCounts(uid, p);
  assert.equal((await post(p)).status, 201);
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 0, burst: 1 });
});

T('(i) a free retry that fails our-fault gets nothing back (no row); its retry is free too', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'none', code: 'FETCH_PROXY_FAILED' });
  const r1 = await post(p);
  assert.equal(r1.status, 201);
  await pool.query(`UPDATE jobs SET status = 'failed', error_code = 'INTERNAL_ERROR' WHERE id = $1`, [r1.body.id]);
  assert.deepEqual(await pool.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [r1.body.id, OUR_FAULT]).then((x) => x.rows), []);
  const before = await rowCounts(uid, p);
  assert.equal((await post(r1.body.id)).status, 201);
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 0, burst: 1 });
});

// ── AC2: the cap, durable across the sweep ───────────────────────────────────────────────

T('AC2: retry 1 and 2 succeed (depth 1, 2), the 3rd → 429 RETRY_LIMIT; GET says cap_reached', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'none' });
  const r1 = await post(p);
  assert.equal(r1.status, 201);
  assert.deepEqual(await jobRow(r1.body.id), { status: 'queued', error_code: null, attempts: 0, retry_of: p, retry_depth: 1, retried_at: null });
  await pool.query(`UPDATE jobs SET status = 'failed', error_code = 'SEPARATION_FAILED' WHERE id = $1`, [r1.body.id]);
  const r2 = await post(r1.body.id);
  assert.equal(r2.status, 201);
  assert.deepEqual((await jobRow(r2.body.id)).retry_depth, 2);
  await pool.query(`UPDATE jobs SET status = 'failed', error_code = 'SEPARATION_FAILED' WHERE id = $1`, [r2.body.id]);
  const r3 = await post(r2.body.id);
  assert.deepEqual([r3.status, r3.body.error_code], [429, 'RETRY_LIMIT']);
  assert.equal((await get(r2.body.id)).body.action, 'cap_reached');
  assert.equal((await one('SELECT count(*)::int AS n FROM jobs WHERE user_id = $1', [uid])).n, 3);
  // AC7: the original is a record — still failed, attempts unchanged, marked retried.
  const orig = await jobRow(p);
  assert.deepEqual([orig.status, orig.error_code, orig.attempts], ['failed', 'FETCH_PROXY_FAILED', 1]);
  assert.ok(orig.retried_at);
  assert.equal((await get(r1.body.id)).body.retry_of, p);
});

T('AC2: root swept → the newest (depth 2) is still refused; a depth-1 orphan retries once to depth 2', async () => {
  const uid = await mkUser();
  const root = await failedParent(uid, { spend: 'none' });
  const d1 = await failedParent(uid, { spend: 'none', retryOf: root, depth: 1 });
  const d2 = await failedParent(uid, { spend: 'none', retryOf: d1, depth: 2 });
  await pool.query('DELETE FROM jobs WHERE id = $1', [root]);
  await pool.query('UPDATE jobs SET retried_at = now() WHERE id = $1', [d1]);
  assert.equal((await post(d2)).status, 429);
  const orphanUid = uid;
  const o1 = await failedParent(orphanUid, { spend: 'none', depth: 1 });
  const r = await post(o1);
  assert.equal(r.status, 201);
  assert.equal((await jobRow(r.body.id)).retry_depth, 2);
});

T('AC2: a parent with retried_at set is refused even after its retry was swept', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'none' });
  const r1 = await post(p);
  assert.equal(r1.status, 201);
  assert.equal((await post(p)).body.id, r1.body.id, 'a second tap returns the first retry');
  await pool.query('DELETE FROM jobs WHERE id = $1', [r1.body.id]);
  const r = await post(p);
  assert.deepEqual([r.status, r.body.error_code], [429, 'RETRY_LIMIT']);
});

// ── AC4: two concurrent retries, real locks ──────────────────────────────────────────────

for (const [name, spend, code] of [['charged unit', 'unit', 'FETCH_PROXY_FAILED'], ['free', 'none', 'DOWNLOAD_BLOCKED'], ['trial + unit', 'trial', 'INTERNAL_ERROR']]) {
  T(`AC4 (${name}): two simultaneous POSTs on one parent → 1 job, ≤ 1 debit, both get its id`, async () => {
    const uid = await mkUser({ trial: spend === 'trial' });
    const p = await failedParent(uid, { spend, code });
    const before = await rowCounts(uid, p);
    // BARRIER (review R1 should-fix 3): neither request may send the retry tx's FIRST lock
    // until BOTH have reached it, so both have passed every lock-free gate. The first to get the
    // lock then holds it, and a third connection must SEE the other one waiting on it. The
    // first lock (#345 lock order: trial_grants → debit row → parent row) is the trial_consume
    // advisory lock on the trial path, the parent's debit row FOR UPDATE when it has one, and
    // the parent's FOR UPDATE when it has none (a debit-row FOR UPDATE that finds no row locks
    // nothing).
    const firstLock = spend === 'trial' ? 'trial' : spend === 'none' ? 'parent' : 'debit';
    const isFirstLock = (sql, params) => ({
      trial: () => /pg_advisory_xact_lock/.test(sql) && params?.[0] === 'trial_consume',
      debit: () => /FROM public\.job_allowance_debits WHERE job_id = \$1::uuid FOR UPDATE/.test(sql),
      parent: () => /FROM jobs WHERE id = \$1::uuid FOR UPDATE/.test(sql),
    })[firstLock]();
    const waitLike = {
      trial: '%pg_advisory_xact_lock%',
      debit: '%job_allowance_debits WHERE job_id = $1::uuid FOR UPDATE%',
      parent: '%retry_depth, retried_at%FOR UPDATE%',
    }[firstLock];
    let arrived = 0;
    let open;
    const gate = new Promise((r) => (open = r));
    let firstLocked = false;
    let sawWait = false;
    globalThis.__retryOnQuery = async (sql, params, run) => {
      if (!isFirstLock(sql, params)) return run();
      arrived += 1;
      if (arrived === 2) open();
      await Promise.race([gate, new Promise((_, rej) => setTimeout(() => rej(new Error('barrier: only one request reached the first lock')), 10_000))]);
      const r = await run();
      if (!firstLocked) {
        firstLocked = true;
        const end = Date.now() + 3000;
        while (Date.now() < end && !sawWait) {
          sawWait = (await pool.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE $1`, [waitLike],
          )).rows[0].n > 0;
          if (!sawWait) await new Promise((res) => setTimeout(res, 20));
        }
      }
      return r;
    };
    let a, b;
    try {
      [a, b] = await Promise.all([post(p), post(p)]);
    } finally {
      globalThis.__retryOnQuery = undefined;
    }
    assert.equal(arrived, 2, 'both requests reached the retry tx\'s first lock');
    assert.ok(sawWait, 'the second request was seen WAITING on that lock (pg_stat_activity)');
    assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
    assert.equal(a.body.id, b.body.id);
    const d = delta(before, await rowCounts(uid, p));
    assert.equal(d.jobs, 1, 'exactly one retry job');
    assert.ok(d.debits <= 1);
    assert.equal(d.jobs_used, spend === 'none' ? 0 : 1, 'charged at most once');
    if (spend === 'trial') assert.equal(d.songs_used, 1);
    assert.equal((await one('SELECT count(*)::int AS n FROM jobs WHERE retry_of = $1', [p])).n, 1);
  });
}

// ── AC6: C-1 ─────────────────────────────────────────────────────────────────────────────

T('C-1: a per-IP 429 retry → retried_at stays NULL, no job, no charge; GET still eligible', async () => {
  const uid = await mkUser({ trial: true });
  for (const [spend, code] of [['none', 'FETCH_PROXY_FAILED'], ['trial', 'FETCH_PROXY_FAILED']]) {
    const p = await failedParent(uid, { spend, code });
    const ip = globalThis.__retryIp;
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint)
         VALUES ($1, '${CANON}', ARRAY['drums'], 4, 'failed', $2, '')`,
        [randomUUID(), ip],
      );
    }
    await pool.query('DELETE FROM public.usage_events WHERE user_id = $1', [uid]);
    const before = await rowCounts(uid, p);
    const r = await post(p);
    assert.deepEqual([r.status, r.body.error_code], [429, 'RATE_LIMITED'], spend);
    assert.equal((await jobRow(p)).retried_at, null, spend);
    const d = delta(before, await rowCounts(uid, p));
    assert.deepEqual({ ...d, burst: 0 }, { jobs: 0, jobs_used: 0, songs_used: 0, debits: 0, burst: 0 }, spend);
    assert.equal((await get(p)).body.action, 'eligible', spend);
    await pool.query('DELETE FROM jobs WHERE client_ip_hash = $1', [ip]);
    globalThis.__retryIp = IP_PREFIX + randomUUID().slice(0, 12);
  }
});

// ── AC3 / AC8 on the real route ──────────────────────────────────────────────────────────

T('AC3: another user\'s and an anonymous job → 404; AC8: ALLOW_YOUTUBE_INPUT unset → 403; nothing written', async () => {
  const owner = await mkUser();
  const p = await failedParent(owner, { spend: 'unit' });
  const intruder = await mkUser();
  assert.equal((await post(p)).status, 404);
  const anon = randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, error_code, client_ip_hash, client_fingerprint)
     VALUES ($1, '${CANON}', ARRAY['drums'], 4, 'failed', 'FETCH_PROXY_FAILED', '${IP_PREFIX}anon', '')`,
    [anon],
  );
  assert.equal((await post(anon)).status, 404);
  globalThis.__retryUser = { user_id: owner };
  delete process.env.ALLOW_YOUTUBE_INPUT;
  const before = await rowCounts(owner, p);
  const r = await post(p);
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  assert.deepEqual([r.status, r.body.error_code], [403, 'DOWNLOAD_INVALID_URL']);
  assert.deepEqual(delta(before, await rowCounts(owner, p)), { jobs: 0, jobs_used: 0, songs_used: null, debits: 0, burst: 0 });
  assert.equal((await jobRow(p)).retried_at, null);
  void intruder;
});

T('AC1: an upload parent → 409 Upload again, and no job reuses its key', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'none', kind: 'upload', code: 'SEPARATION_FAILED' });
  const r = await post(p);
  assert.deepEqual([r.status, r.body.error_code], [409, 'UPLOAD_AGAIN']);
  assert.equal((await one('SELECT count(*)::int AS n FROM jobs WHERE upload_r2_key = $1', [`${p}/_input.mp3`])).n, 1);
});

// ── review R1 should-fix 1: the late-restore race, on real locks ─────────────────────────

T('late restore AFTER a free retry: the retry claimed the row, the restore gives nothing back (no +1)', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'FETCH_PROXY_FAILED', restore: false });
  assert.deepEqual(await restoreOf(p), { claimed: false, allowance_restored: null, trial_restored: null }, 'precondition: restore pending');
  const before = await rowCounts(uid, p);
  const r = await post(p);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // the worker's second transaction gives back only what is still owed
  const late = (await pool.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [p, OUR_FAULT])).rows;
  assert.deepEqual(late, [], 'the late restore finds the row claimed by the retry');
  assert.deepEqual(await restoreOf(p), { claimed: true, allowance_restored: false, trial_restored: false });
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 0, burst: 1 },
    'net: the failed song and its free retry cost one unit, never +1');
});

T('restore IN PROGRESS when the retry starts: the retry waits on the debit row, then is CHARGED', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'FETCH_PROXY_FAILED', restore: false });
  const before = await rowCounts(uid, p);
  const x = await pool.connect();
  let r;
  try {
    await x.query('BEGIN');
    assert.deepEqual((await x.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [p, OUR_FAULT])).rows,
      [{ allowance_restored: true, trial_restored: false }], 'the restore holds the row, uncommitted');
    const pending = post(p);
    let waiting = false;
    const end = Date.now() + 10_000;
    while (!waiting && Date.now() < end) {
      waiting = (await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FROM public.job_allowance_debits WHERE job_id = $1::uuid FOR UPDATE%'`,
      )).rows[0].n > 0;
      if (!waiting) await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(waiting, 'the retry is waiting on the parent debit row lock');
    await x.query('COMMIT');
    r = await pending;
  } finally {
    x.release();
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = delta(before, await rowCounts(uid, p));
  assert.deepEqual({ ...d, burst: 0 }, { jobs: 1, jobs_used: 0, songs_used: null, debits: 1, burst: 0 },
    '1 spent → 1 given back → 1 spent by the retry: charged, net 0');
  assert.equal(d.burst, 1, 'one request, one burst row: the re-run for the charged decision does not record a second (#345)');
  assert.deepEqual(await one('SELECT trial_song, allowance_period_start IS NOT NULL AS has_period FROM public.job_allowance_debits WHERE job_id = $1', [r.body.id]),
    { trial_song: false, has_period: true });
});

// ── #345: B3 residue ─────────────────────────────────────────────────────────────────────

// The worker's fail_job SECOND transaction, statement for statement: restore_job_allowance()
// locks the parent's debit row, then job_failure._NOTE_RESTORED_SQL updates the parent's job row.
const ALLOWANCE_RETURNED_SENTENCE = "This didn't count toward your monthly songs.";
const NOTE_RESTORED_SQL = `UPDATE jobs SET error_message_user = COALESCE(error_message_user || ' ', '') || $1 WHERE id = $2`;
const DEBIT_LOCK_RE = /FROM public\.job_allowance_debits WHERE job_id = \$1::uuid FOR UPDATE/;

async function waitForLockWait(like) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const n = (await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [like],
    )).rows[0].n;
    if (n > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

T('#345 lock order: worker restore (debit row → job row) concurrent with a retry → no deadlock; retry charged', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'FETCH_PROXY_FAILED', restore: false });
  const before = await rowCounts(uid, p);
  const x = await pool.connect();
  let r;
  let workerErr = null;
  try {
    await x.query('BEGIN');
    // 1. The worker claims the debit row (uncommitted) ...
    assert.deepEqual((await x.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [p, OUR_FAULT])).rows,
      [{ allowance_restored: true, trial_restored: false }]);
    // 2. ... a retry starts and blocks on that debit row ...
    const pending = post(p);
    assert.ok(await waitForLockWait('%FROM public.job_allowance_debits WHERE job_id = $1::uuid FOR UPDATE%'),
      'the retry is waiting on the parent debit row lock');
    // 3. ... then the worker updates the parent's job row. With the old order (parent row first)
    // the retry held this row while waiting for the debit row: a cycle, 40P01 on one side.
    try {
      await x.query(NOTE_RESTORED_SQL, [ALLOWANCE_RETURNED_SENTENCE, p]);
      await x.query('COMMIT');
    } catch (e) {
      workerErr = e;
      await x.query('ROLLBACK');
    }
    r = await pending;
  } finally {
    x.release();
  }
  assert.equal(workerErr, null, `the worker's job-row update was not aborted: ${workerErr?.code} ${workerErr?.message}`);
  assert.equal(r.status, 201, `the retry was not aborted: ${JSON.stringify(r.body)}`);
  // Consistent: the restore committed in full, and the retry saw it and was charged for it.
  assert.deepEqual(await restoreOf(p), { claimed: true, allowance_restored: true, trial_restored: false });
  assert.match((await one('SELECT error_message_user FROM jobs WHERE id = $1', [p])).error_message_user ?? '', /didn't count toward your monthly songs/);
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 1, burst: 1 },
    '1 spent → 1 given back → 1 spent by the retry; one burst row');
  assert.ok((await jobRow(p)).retried_at, 'the parent is marked retried');
  assert.equal((await jobRow(r.body.id)).retry_of, p);
});

T('#345 lock order: the retry holds the debit row → the worker restore waits, then gives nothing back; no deadlock', async () => {
  const uid = await mkUser();
  const p = await failedParent(uid, { spend: 'unit', code: 'FETCH_PROXY_FAILED', restore: false });
  const before = await rowCounts(uid, p);
  // Hold the retry just after its FIRST lock (the debit row) is granted, then run the worker's
  // whole second transaction on another connection: it must wait for the retry, never cycle.
  let release;
  const held = new Promise((res) => (release = res));
  let reached;
  const atLock = new Promise((res) => (reached = res));
  globalThis.__retryOnQuery = async (sql, params, run) => {
    const out = await run();
    if (DEBIT_LOCK_RE.test(sql)) { reached(); await held; }
    return out;
  };
  let r;
  let worker;
  try {
    const pending = post(p);
    await atLock;
    const x = await pool.connect();
    worker = (async () => {
      try {
        await x.query('BEGIN');
        const rows = (await x.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [p, OUR_FAULT])).rows;
        if (rows.some((row) => row.allowance_restored || row.trial_restored)) {
          await x.query(NOTE_RESTORED_SQL, [ALLOWANCE_RETURNED_SENTENCE, p]);
        }
        await x.query('COMMIT');
        return { rows };
      } catch (e) {
        await x.query('ROLLBACK');
        return { err: e };
      } finally {
        x.release();
      }
    })();
    assert.ok(await waitForLockWait('%restore_job_allowance%'), 'the worker restore waits on the retry');
    release();
    r = await pending;
  } finally {
    release();
    globalThis.__retryOnQuery = undefined;
  }
  const w = await worker;
  assert.equal(w.err, undefined, `worker aborted: ${w.err?.code} ${w.err?.message}`);
  assert.deepEqual(w.rows, [], 'the restore finds the row claimed by the retry');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(await restoreOf(p), { claimed: true, allowance_restored: false, trial_restored: false });
  assert.deepEqual(delta(before, await rowCounts(uid, p)), { jobs: 1, jobs_used: 0, songs_used: null, debits: 0, burst: 1 },
    'free retry, nothing given back: never +1');
});

T('#345 mutant R3: a CHARGED retry leaves the parent\'s already-restored debit row exactly as the restore wrote it', async () => {
  for (const [spend, code, rollPeriod, want] of [
    ['unit', 'FETCH_PROXY_FAILED', false, { allowance_restored: true, trial_restored: false }],
    ['trial', 'INTERNAL_ERROR', false, { allowance_restored: true, trial_restored: true }],
    ['trial', 'INTERNAL_ERROR', true, { allowance_restored: false, trial_restored: true }],
  ]) {
    const uid = await mkUser({ trial: true });
    const p = await failedParent(uid, { spend, code, rollPeriod });
    const audit = () => one('SELECT restored_at, allowance_restored, trial_restored FROM public.job_allowance_debits WHERE job_id = $1', [p]);
    const was = await audit();
    assert.deepEqual({ allowance_restored: was.allowance_restored, trial_restored: was.trial_restored }, want, 'precondition');
    await new Promise((res) => setTimeout(res, 5)); // a later transaction's now() differs
    const r = await post(p);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await audit(), was, `${spend}/rollPeriod=${rollPeriod}: restored_at and both flags unchanged`);
  }
});

T('GET (review R1): a used-up trial is refused with the retry line, not a credit-pack line', async () => {
  const uid = await mkUser({ trial: true });
  const p = await failedParent(uid, { spend: 'trial', code: 'INTERNAL_ERROR', rollPeriod: true });
  await pool.query('UPDATE public.trial_grants SET songs_used = 3 WHERE user_id = $1', [uid]);
  const g = await get(p);
  assert.equal(g.body.action, 'trial_used');
  assert.doesNotMatch(g.body.message, /credit/i);
  const r = await post(p);
  assert.deepEqual([r.status, r.body.error_code], [402, 'TRIAL_EXHAUSTED']);
  assert.doesNotMatch(r.body.message, /credit/i);
});
