// #372 against a REAL Postgres: POST /api/jobs (signed-in pasted link) with the REAL module graph —
// route.ts, create-link-job.ts, library-server.ts pasteHooks, admission, rate-limit,
// entitlements, trial — on the migrated database in DATABASE_URL (CI's Tests job has one).
// Stubbed: getUser, the client-IP hash (fresh per test), Sentry, next/server.
//
//   (a) two truly concurrent pastes of one URL -> 1 job, 1 debit, both answer its id. A barrier
//       holds each request's first in-tx dedupe statement until both arrived (so both passed
//       findExisting and every gate), and a third connection must SEE the loser waiting on the
//       lock in pg_stat_activity (the pattern of phase-b-concurrency-pg, PR #371). Free (4 of 5
//       used: the last song) and trial.
//   (b) sequential re-paste while queued -> same id, 0 new rows (jobs, debits, usage_events).
//   (c) re-paste of a done and retained job -> same id, no charge.
//   (d) re-paste after the previous job FAILED -> a new job, charged normally.
//   (e) a different URL -> a new job.
//   R2 MF-1: same URL, a different stem selection -> a new job, charged; the same set in another
//       order -> the same job.
//   R2 MF-2: a paste racing a Re-make of the same URL (non-trial) -> 1 job, 1 debit; the loser
//       is SEEN waiting on the shared link-dedupe lock.
//
// Skips locally without a LOCAL DATABASE_URL and FAILS under CI=true (a skipped gate is not a
// pass). Never point it at a shared database: it INSERTs into auth.users and jobs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { buildModuleGraph } from './helpers/module-graph.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(WEB, 'package.json'));

const DB_URL = process.env.DATABASE_URL;
let skip = false;
if (!DB_URL) skip = 'DATABASE_URL not set';
else {
  const host = new URL(DB_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', ''].includes(host)) skip = `DATABASE_URL host ${host} is not local`;
}
if (skip && process.env.CI) throw new Error(`CI=true but ${skip}`);

let pool, jobs, remake, ent;
if (!skip) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, max: 12 });
  globalThis.__ldPool = pool;
  // Test hook: globalThis.__ldOnQuery(sql, params, run) sees every statement a db.tx client sends.
  globalThis.__ldOnQuery = undefined;
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  process.env.ADMISSION_MAX_IN_FLIGHT = '100000'; // other suites' queued jobs share this database
  const graph = buildModuleGraph({
    name: 'jobs-link-dedupe-pg',
    entries: ['app/api/jobs/route.ts', 'app/api/library/remake/route.ts', 'lib/billing/entitlements.ts'],
    overrides: {
      'lib/db.ts': `export const db = {
        query: (t, p) => globalThis.__ldPool.query(t, p),
        tx: async (fn) => { const c = await globalThis.__ldPool.connect();
          const client = { query: (t, p) => {
            const h = globalThis.__ldOnQuery;
            return h ? h(String(t), p, () => c.query(t, p)) : c.query(t, p);
          } };
          try { await c.query('BEGIN'); const r = await fn(client); await c.query('COMMIT'); return r; }
          catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } },
      };`,
      'lib/auth/supabase.ts': 'export const getUser = async () => globalThis.__ldUser ?? null; export const deleteAuthUser = async () => {};',
      'lib/client-ip.ts': 'export const clientIpHashOf = () => globalThis.__ldIp;',
      // QW-2: the R2 stem probe (no R2 here). Ids in __ldBroken have no playable stems.
      'lib/jobs/stem-artifacts.ts': 'export const hasPlayableStems = async (id) => !(globalThis.__ldBroken ?? []).includes(id);',
    },
    packages: {
      '@sentry/nextjs': 'export const captureException = (e) => { (globalThis.__ldCaptured ??= []).push(e); }; export const captureMessage = () => {};',
      'next/server': `export class NextResponse { constructor(body, init = {}) { this.body = JSON.parse(body); this.status = init.status ?? 200; }
          static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }
        export class NextRequest {}`,
    },
  });
  jobs = await import(graph.url('app/api/jobs/route.ts'));
  remake = await import(graph.url('app/api/library/remake/route.ts'));
  ent = await import(graph.url('lib/billing/entitlements.ts'));
}

const EMAIL_PREFIX = 'test-web-link-dedupe-';
after(async () => {
  if (!pool) return;
  const like = `(SELECT id FROM public.users WHERE email LIKE '${EMAIL_PREFIX}%')`;
  await pool.query(`DELETE FROM public.jobs WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM public.usage_events WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

const HOST = 'stem-loops.com';
const req = (body) => ({
  headers: new Headers({ origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' }),
  json: async () => body,
  nextUrl: new URL(`https://${HOST}/api/jobs`),
  url: `https://${HOST}/api/jobs`,
});
const as = (u) => {
  globalThis.__ldUser = u;
  globalThis.__ldIp = `ld-${randomUUID()}`; // a fresh per-IP window per test
  ent?._resetEntitlementCacheForTests();
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function user({ trial = false, jobsUsed = null } = {}) {
  const id = randomUUID();
  await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${EMAIL_PREFIX}${id.slice(0, 8)}@example.test`]);
  if (trial) await pool.query('INSERT INTO public.trial_grants (user_id) VALUES ($1)', [id]);
  if (jobsUsed !== null) {
    await pool.query(
      `INSERT INTO public.entitlements (user_id, plan_code, period_start, period_end, jobs_used)
       VALUES ($1, 'free', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', $2)
       ON CONFLICT (user_id) DO UPDATE SET plan_code = 'free', period_start = EXCLUDED.period_start,
         period_end = EXCLUDED.period_end, jobs_used = EXCLUDED.jobs_used`,
      [id, jobsUsed],
    );
  }
  return { user_id: id, email: `${id}@example.test` };
}
const vid = () => randomUUID().replace(/-/g, '').slice(0, 11);
const canon = (v) => `https://www.youtube.com/watch?v=${v}`;
async function counts(u, url) {
  return one(
    `SELECT (SELECT count(*)::int FROM jobs WHERE user_id = $1 AND youtube_url = $2) AS jobs,
            (SELECT count(*)::int FROM job_allowance_debits WHERE user_id = $1) AS debits,
            (SELECT COALESCE(max(jobs_used), 0)::int FROM entitlements WHERE user_id = $1) AS jobs_used,
            (SELECT COALESCE(max(songs_used), 0)::int FROM trial_grants WHERE user_id = $1) AS songs_used,
            (SELECT count(*)::int FROM usage_events WHERE user_id = $1) AS usage_rows`,
    [u.user_id, url],
  );
}
const paste = (url, extra = {}) => jobs.POST(req({ url, ...extra }));
const HIT = (id) => ({ id, existing: true });

/** Wait until another session is blocked on a lock while running a statement LIKE `like`. */
async function sawLockWait(like, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const n = (await one(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [like],
    )).n;
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/**
 * A two-party barrier (PR #371's lockBarrier). Each request's FIRST statement matching `match` is
 * held until BOTH requests have reached one, then sent; later matches pass straight through. The
 * first request to get its result back then holds its lock while this connection looks for the
 * other one WAITING (`waitLike`). The match also covers the in-tx lookup and the INSERT, so a
 * mutant without the lock (or without beforeInsert) still reaches the barrier and fails on the
 * OUTCOME, not on a barrier timeout.
 */
function lockBarrier(match, waitLike) {
  const st = { arrived: 0, sawWait: false };
  let open;
  const gate = new Promise((r) => (open = r));
  let first = true;
  st.onQuery = async (sql, params, run) => {
    if (!match(sql, params) || st.arrived >= 2) return run();
    st.arrived += 1;
    if (st.arrived === 2) open();
    await Promise.race([gate, new Promise((_, rej) => setTimeout(() => rej(new Error('barrier: only one request reached the lock')), 10_000))]);
    const r = await run();
    if (first) {
      first = false;
      st.sawWait = await sawLockWait(waitLike);
    }
    return r;
  };
  return st;
}
async function withHook(onQuery, fn) {
  globalThis.__ldOnQuery = onQuery;
  try {
    return await fn();
  } finally {
    globalThis.__ldOnQuery = undefined;
  }
}

// The non-trial insert tx's first statement is the link-dedupe lock (or, under a mutant, the
// in-tx lookup / the INSERT).
const DEDUPE_POINT = (sql) =>
  /hashtextextended\('link-dedupe:'/.test(sql) || /SELECT jobs\.id::text AS id FROM jobs/.test(sql) || /^INSERT INTO jobs/.test(sql);
const DEDUPE_WAIT = "%pg_advisory_xact_lock(hashtextextended('link-dedupe:'%";
// consumeTrialInTx's per-user advisory lock: the FIRST lock of the trial insert tx.
const TRIAL_LOCK = (sql, params) => /pg_advisory_xact_lock/.test(sql) && params?.[0] === 'trial_consume';
const TRIAL_WAIT = '%pg_advisory_xact_lock%';

for (const c of [
  { name: 'Free, the last song (4 of 5 used)', opts: { jobsUsed: 4 }, lock: [DEDUPE_POINT, DEDUPE_WAIT], want: { jobs_used: 1, songs_used: 0 } },
  { name: 'trial', opts: { trial: true }, lock: [TRIAL_LOCK, TRIAL_WAIT], want: { songs_used: 1 } },
]) {
  test(`(a) ${c.name}: two truly concurrent pastes of one URL -> 1 job, 1 debit, both answer its id`, { skip, timeout: 60_000 }, async () => {
    const u = await user(c.opts);
    const url = canon(vid());
    const before = await counts(u, url);
    as(u);
    const b = lockBarrier(...c.lock);
    const results = await withHook(b.onQuery, () => Promise.all([paste(url), paste(`https://youtu.be/${url.slice(-11)}`)]));
    assert.equal(b.arrived, 2, 'both requests passed findExisting and every gate, and reached the first contended statement');
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 201], JSON.stringify(results.map((r) => r.body)));
    assert.equal(results[0].body.id, results[1].body.id, "the loser answers with the winner's job");
    const after = await counts(u, url);
    assert.equal(after.jobs - before.jobs, 1, 'exactly one job');
    assert.equal(after.debits - before.debits, 1, 'exactly one job_allowance_debits row');
    for (const [k, v] of Object.entries(c.want)) assert.equal(after[k] - before[k], v, `${k} charged exactly once`);
    assert.ok(b.sawWait, 'the loser was SEEN waiting on the lock (pg_stat_activity): the race was real');
  });
}

test('(b) re-paste while queued -> same id, 0 new rows (no job, debit, jobs_used or burst row)', { skip }, async () => {
  const u = await user();
  const url = canon(vid());
  as(u);
  const first = await paste(url);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const before = await counts(u, url);
  assert.deepEqual([before.jobs, before.debits, before.jobs_used], [1, 1, 1]);
  const again = await paste(`${url}&t=30`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, HIT(first.body.id));
  assert.deepEqual(await counts(u, url), before);
});

test('(c) re-paste of a done and retained job -> same id, no charge', { skip }, async () => {
  const u = await user();
  const url = canon(vid());
  as(u);
  const first = await paste(url);
  assert.equal(first.status, 201);
  await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [first.body.id]);
  const before = await counts(u, url);
  const again = await paste(url);
  assert.deepEqual([again.status, again.body], [200, HIT(first.body.id)]);
  assert.deepEqual(await counts(u, url), before);
  // Past retention it is no longer live: a fresh, charged job.
  await pool.query("UPDATE jobs SET created_at = now() - interval '30 hours', expires_at = now() - interval '6 hours' WHERE id = $1", [first.body.id]);
  const fresh = await paste(url);
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  assert.notEqual(fresh.body.id, first.body.id);
  assert.equal((await counts(u, url)).jobs_used, before.jobs_used + 1);
});

test('QW-2: re-paste of a done job with no playable stems -> a new job, charged; a playable older one is reused', { skip }, async () => {
  const u = await user();
  const url = canon(vid());
  as(u);
  const first = await paste(url);
  assert.equal(first.status, 201);
  await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [first.body.id]);
  globalThis.__ldBroken = [first.body.id];
  try {
    const before = await counts(u, url);
    const fresh = await paste(url);
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    assert.notEqual(fresh.body.id, first.body.id);
    const after1 = await counts(u, url);
    assert.equal(after1.jobs, before.jobs + 1);
    assert.equal(after1.jobs_used, before.jobs_used + 1);
    // The new job is queued: the next re-paste reuses it, nothing charged.
    const again = await paste(url);
    assert.deepEqual([again.status, again.body], [200, HIT(fresh.body.id)]);
    assert.deepEqual(await counts(u, url), after1);
    // Newer done job broken, older done job playable -> the older one ($7 skip list on real PG).
    await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [fresh.body.id]);
    globalThis.__ldBroken = [fresh.body.id];
    const older = await paste(url);
    assert.deepEqual([older.status, older.body], [200, HIT(first.body.id)]);
    assert.deepEqual(await counts(u, url), after1);
  } finally {
    globalThis.__ldBroken = undefined;
  }
});

test('(d) re-paste after the previous job FAILED -> a new job, charged normally', { skip }, async () => {
  const u = await user();
  const url = canon(vid());
  as(u);
  const first = await paste(url);
  assert.equal(first.status, 201);
  await pool.query("UPDATE jobs SET status = 'failed', error_code = 'FETCH_PROXY_FAILED' WHERE id = $1", [first.body.id]);
  const before = await counts(u, url);
  const again = await paste(url);
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.id, first.body.id);
  const after = await counts(u, url);
  assert.deepEqual(
    [after.jobs - before.jobs, after.debits - before.debits, after.jobs_used - before.jobs_used],
    [1, 1, 1],
  );
});

test('(e) a different URL -> a new job, charged', { skip }, async () => {
  const u = await user();
  const a = canon(vid());
  const b = canon(vid());
  as(u);
  const ra = await paste(a);
  const rb = await paste(b);
  assert.deepEqual([ra.status, rb.status], [201, 201]);
  assert.notEqual(ra.body.id, rb.body.id);
  assert.equal((await counts(u, b)).jobs, 1);
  assert.equal((await counts(u, b)).jobs_used, 2);
});

// ── #372 R2 ─────────────────────────────────────────────────────────────────────────────────

test('R2 MF-1: same URL, a DIFFERENT stem selection -> a new job, charged normally; same set reordered -> same job', { skip }, async () => {
  const u = await user();
  const url = canon(vid());
  as(u);
  const drums = await paste(url, { stems: ['drums'] });
  assert.equal(drums.status, 201, JSON.stringify(drums.body));
  const before = await counts(u, url);
  const all = await paste(url);
  assert.equal(all.status, 201, JSON.stringify(all.body));
  assert.notEqual(all.body.id, drums.body.id);
  const after = await counts(u, url);
  assert.deepEqual(
    [after.jobs - before.jobs, after.debits - before.debits, after.jobs_used - before.jobs_used],
    [1, 1, 1],
  );
  const stored = (await one('SELECT requested_stems FROM jobs WHERE id = $1', [all.body.id])).requested_stems;
  assert.equal(stored.length, 6, 'the new job asks for all six');
  // All six spelt out in another order is the default selection: the same job, no charge.
  const spelt = await paste(url, { stems: ['other', 'keys', 'guitar', 'vocals', 'bass', 'drums'] });
  assert.deepEqual([spelt.status, spelt.body], [200, HIT(all.body.id)]);
  // A different loop length is a different product too.
  const eight = await paste(url, { loop_length_bars: 8 });
  assert.equal(eight.status, 201, JSON.stringify(eight.body));
  assert.deepEqual(await counts(u, url).then((c) => c.jobs), 3);
});

async function entry(u, url) {
  const r = await pool.query(
    `INSERT INTO public.library_entries (user_id, input_kind, youtube_url, title, bpm, musical_key)
     VALUES ($1, 'youtube', $2, 'Expired song', 101, 'D minor') RETURNING id::text AS id`,
    [u.user_id, url],
  );
  return r.rows[0].id;
}

test('R2 MF-2: a paste racing a Re-make of the same URL (non-trial) -> 1 job, 1 debit, both answer its id', { skip, timeout: 60_000 }, async () => {
  const u = await user({ jobsUsed: 0 });
  const url = canon(vid());
  const entryId = await entry(u, url);
  const before = await counts(u, url);
  as(u);
  const b = lockBarrier(DEDUPE_POINT, DEDUPE_WAIT);
  const results = await withHook(b.onQuery, () => Promise.all([paste(url), remake.POST(req({ entry_id: entryId }))]));
  assert.equal(b.arrived, 2, 'both requests passed findExisting and every gate, and reached the link-dedupe point');
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201], JSON.stringify(results.map((r) => r.body)));
  assert.equal(results[0].body.id, results[1].body.id, "the loser answers with the winner's job");
  const after = await counts(u, url);
  assert.equal(after.jobs - before.jobs, 1, 'exactly one job');
  assert.equal(after.debits - before.debits, 1, 'exactly one job_allowance_debits row');
  assert.equal(after.jobs_used - before.jobs_used, 1, 'one song spent');
  assert.ok(b.sawWait, 'the loser was SEEN waiting on the shared link-dedupe lock (pg_stat_activity)');
});
