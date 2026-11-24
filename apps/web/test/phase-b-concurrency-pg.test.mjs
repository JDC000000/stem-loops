// Phase B follow-up: the REAL-Postgres concurrency cases for B0–B3 that the per-feature pg suites
// did not yet prove (PHASE-B-BRIEF r4.2). Already covered elsewhere, and NOT repeated here:
//   B1 AC4  two concurrent Re-makes of one entry (Free allowance)  -> library-remake-pg.test.mjs
//   B2 AC4  10 concurrent reorders + an add, final = one reorder   -> set-lists-pg.test.mjs
//   B3 AC4  two concurrent retries at depth 0 (unit / free / trial) -> job-retry-pg.test.mjs
// Added here:
//   B0 AC3  the hook contract on real locks, per funding branch the B1 test does not run (trial,
//           paid) and at the quota boundary (exactly 1 song left), concurrent AND sequential.
//           POST /api/jobs passes no hooks (a pasted link is never deduplicated); the only
//           production hooks are Re-make's (lib/library-server.ts remakeHooks), so the contract
//           is driven through POST /api/library/remake with the REAL lib and REAL hooks.
//   B2 AC4  two reorders with a PROVEN overlap (the second is seen waiting on the list lock),
//           and a reorder racing a remove (stale order -> 409, never a gap).
//   B3 AC4  the cap under concurrency: two retries of a depth-1 parent -> one depth-2 child,
//           parent.retried_at written once (by the winner's tx); then two retries of that
//           depth-2 child -> both 429, no depth-3 row. And the lib's under-lock cap alone, with
//           the route's lock-free cap read raced (#374).
// Each race also asserts what was spent: jobs, debits, jobs_used, trial songs, burst rows (#374).
//
// Every race is real: two requests on two pooled connections, a barrier that holds each one just
// before the first contended lock until both have arrived, and a third connection that must SEE
// the loser waiting on that lock in pg_stat_activity. No sleep is used as synchronisation (the
// only timers are timeouts that turn a hang into a red test, and the pg_stat_activity poll).
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

let pool, remake, retry, lists, songs, ent;
if (!skip) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, max: 12 });
  globalThis.__pbPool = pool;
  // Test hook: globalThis.__pbOnQuery(sql, params, run) sees every statement a db.tx client
  // sends and may hold it (a barrier) or observe its result. Absent, statements pass through.
  globalThis.__pbOnQuery = undefined;
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  process.env.ADMISSION_MAX_IN_FLIGHT = '100000'; // other suites' queued jobs share this database
  const graph = buildModuleGraph({
    name: 'phase-b-concurrency-pg',
    entries: [
      'app/api/library/remake/route.ts',
      'app/api/jobs/[id]/retry/route.ts',
      'app/api/set-lists/route.ts',
      'app/api/set-lists/[id]/songs/route.ts',
      'lib/billing/entitlements.ts',
    ],
    overrides: {
      'lib/db.ts': `export const db = {
        query: (t, p) => globalThis.__pbPool.query(t, p),
        tx: async (fn) => { const c = await globalThis.__pbPool.connect();
          const client = { query: (t, p) => {
            const h = globalThis.__pbOnQuery;
            return h ? h(String(t), p, () => c.query(t, p)) : c.query(t, p);
          } };
          try { await c.query('BEGIN'); const r = await fn(client); await c.query('COMMIT'); return r; }
          catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } },
      };`,
      'lib/auth/supabase.ts': 'export const getUser = async () => globalThis.__pbUser ?? null; export const deleteAuthUser = async () => {};',
      'lib/client-ip.ts': 'export const clientIpHashOf = () => globalThis.__pbIp;',
    },
    packages: {
      '@sentry/nextjs': 'export const captureException = (e) => { (globalThis.__pbCaptured ??= []).push(e); }; export const captureMessage = () => {};',
      'next/server': `export class NextResponse { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
          static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }
        export class NextRequest {}`,
    },
  });
  remake = await import(graph.url('app/api/library/remake/route.ts'));
  retry = await import(graph.url('app/api/jobs/[id]/retry/route.ts'));
  lists = await import(graph.url('app/api/set-lists/route.ts'));
  songs = await import(graph.url('app/api/set-lists/[id]/songs/route.ts'));
  ent = await import(graph.url('lib/billing/entitlements.ts'));
}

const EMAIL_PREFIX = 'test-web-phase-b-conc-';
after(async () => {
  if (!pool) return;
  const like = `(SELECT id FROM public.users WHERE email LIKE '${EMAIL_PREFIX}%')`;
  await pool.query(`DELETE FROM public.set_lists WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM public.jobs WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM public.usage_events WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

// ── shared helpers ──────────────────────────────────────────────────────────────────────────

const HOST = 'stem-loops.com';
const req = (body, path = '/api/library/remake') => ({
  headers: new Headers({ origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' }),
  json: async () => body,
  nextUrl: new URL(`https://${HOST}${path}`),
  url: `https://${HOST}${path}`,
});
const as = (u) => {
  globalThis.__pbUser = u;
  globalThis.__pbIp = `pbc-${randomUUID()}`; // a fresh per-IP window per test
  ent?._resetEntitlementCacheForTests();
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function user({ trial = false, jobsUsed = null, plan = 'free' } = {}) {
  const id = randomUUID();
  await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${EMAIL_PREFIX}${id.slice(0, 8)}@example.test`]);
  if (trial) await pool.query('INSERT INTO public.trial_grants (user_id) VALUES ($1)', [id]);
  if (jobsUsed !== null || plan !== 'free') {
    await pool.query(
      `INSERT INTO public.entitlements (user_id, plan_code, period_start, period_end, jobs_used)
       VALUES ($1, $2, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', $3)
       ON CONFLICT (user_id) DO UPDATE SET plan_code = EXCLUDED.plan_code, period_start = EXCLUDED.period_start,
         period_end = EXCLUDED.period_end, jobs_used = EXCLUDED.jobs_used`,
      [id, plan, jobsUsed ?? 0],
    );
  }
  if (plan !== 'free') {
    // effectivePlanCode() trusts a paid plan only with a live subscription behind it.
    await pool.query(
      `INSERT INTO public.subscriptions (user_id, provider, provider_subscription_id, plan_code, status, current_period_start, current_period_end)
       VALUES ($1, 'stripe', $2, $3, 'active', now() - interval '1 day', now() + interval '29 days')`,
      [id, `sub_pbc_${randomUUID().slice(0, 12)}`, plan],
    );
  }
  return { user_id: id, email: `${id}@example.test` };
}

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
 * `p`, or a rejection with `msg` after `ms`. The timer is always cleared, so a settled race
 * leaves no 10 s timer keeping the process alive (#374).
 */
async function within(p, ms, msg) {
  let timer;
  try {
    return await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A two-party barrier on the first contended lock. Each request's statement matching `match` is
 * held until BOTH requests have reached it (so both have passed every lock-free gate), then
 * sent. The first one to get its result back then holds on to its lock while this connection
 * looks for the other one WAITING on it (`waitLike`, pg_stat_activity). A request that never
 * reaches the lock fails the barrier after 10 s instead of hanging.
 */
function lockBarrier(match, waitLike) {
  const st = { arrived: 0, sawWait: false };
  let open;
  const gate = new Promise((r) => (open = r));
  let first = true;
  st.onQuery = async (sql, params, run) => {
    if (!match(sql, params)) return run();
    st.arrived += 1;
    if (st.arrived === 2) open();
    await within(gate, 10_000, 'barrier: only one request reached the lock');
    const r = await run();
    if (first) {
      first = false;
      st.sawWait = await sawLockWait(waitLike);
    }
    return r;
  };
  return st;
}

/** Run `fn` with `onQuery` installed on every db.tx client, and always uninstall it. */
async function withHook(onQuery, fn) {
  globalThis.__pbOnQuery = onQuery;
  try {
    return await fn();
  } finally {
    globalThis.__pbOnQuery = undefined;
  }
}

// ── B0 AC3 (through Re-make: the real lib + the real hooks) ─────────────────────────────────

const vid = () => randomUUID().replace(/-/g, '').slice(0, 11);
async function entry(u) {
  const url = `https://www.youtube.com/watch?v=${vid()}`;
  const r = await pool.query(
    `INSERT INTO public.library_entries (user_id, input_kind, youtube_url, title, bpm, musical_key)
     VALUES ($1, 'youtube', $2, 'Expired song', 101, 'D minor') RETURNING id::text AS id`,
    [u.user_id, url],
  );
  return { id: r.rows[0].id, url };
}
async function b0Counts(u, url) {
  return one(
    `SELECT (SELECT count(*)::int FROM jobs WHERE user_id = $1 AND youtube_url = $2) AS jobs,
            (SELECT count(*)::int FROM job_allowance_debits WHERE user_id = $1) AS debits,
            (SELECT COALESCE(max(jobs_used), 0)::int FROM entitlements WHERE user_id = $1) AS jobs_used,
            (SELECT COALESCE(max(songs_used), 0)::int FROM trial_grants WHERE user_id = $1) AS songs_used,
            (SELECT count(*)::int FROM usage_events WHERE user_id = $1) AS usage_rows,
            (SELECT count(*)::int FROM usage_events WHERE user_id = $1 AND kind = 'job_start_attempt') AS burst_rows`,
    [u.user_id, url],
  );
}
const remakeOf = (e) => remake.POST(req({ entry_id: e.id }));

// beforeInsert's entry lock. Matched WITHOUT "FOR UPDATE", so a mutant that drops the lock still
// reaches the barrier and fails on the outcome, not on a barrier timeout.
const ENTRY_LOCK = (sql) => /FROM library_entries WHERE id = \$1::uuid AND user_id = \$2::uuid/.test(sql);
const ENTRY_WAIT = '%FROM library_entries WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE%';
// consumeTrialInTx's per-user advisory lock (trial branch: the FIRST lock of the insert tx).
const TRIAL_LOCK = (sql, params) => /pg_advisory_xact_lock/.test(sql) && params?.[0] === 'trial_consume';
const TRIAL_WAIT = '%pg_advisory_xact_lock%';

// burst_rows (#374): the non-trial branch calls checkBurstLimit BEFORE its tx, so both requests
// (each proven to reach the entry lock, inside that tx) write one job_start_attempt row: the
// winner's plus the one extra the D-e concurrent residue allows, never more. The trial branch
// never calls it (both consumes succeed: TRIAL_SONG_CAP = 3), so it writes none.
// jobs_used (#374): the trial branch bumps it too (bumpJobsUsed upserts the entitlements row),
// and the loser's rolled-back tx must not.
for (const c of [
  { name: 'Free allowance at exactly 1 song left (4 of 5)', opts: { jobsUsed: 4 }, lock: [ENTRY_LOCK, ENTRY_WAIT], want: { jobs_used: 1, songs_used: 0, burst_rows: 2 } },
  { name: 'trial', opts: { trial: true }, lock: [TRIAL_LOCK, TRIAL_WAIT], want: { jobs_used: 1, songs_used: 1, burst_rows: 0 } },
  { name: 'paid (Pro)', opts: { plan: 'pro', jobsUsed: 0 }, lock: [ENTRY_LOCK, ENTRY_WAIT], want: { jobs_used: 1, songs_used: 0, burst_rows: 2 } },
]) {
  test(`B0 AC3 (${c.name}): two truly concurrent link-job creations, same user + URL -> 1 job, 1 debit, both get its id`, { skip, timeout: 60_000 }, async () => {
    const u = await user(c.opts);
    const e = await entry(u);
    const before = await b0Counts(u, e.url);
    as(u);
    const b = lockBarrier(...c.lock);
    const results = await withHook(b.onQuery, () => Promise.all([remakeOf(e), remakeOf(e)]));
    assert.equal(b.arrived, 2, 'both requests passed findExisting and every gate, and reached the first contended lock');
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 201], JSON.stringify(results.map((r) => r.body)));
    assert.equal(results[0].body.id, results[1].body.id, "the loser answers with the winner's job");
    const after = await b0Counts(u, e.url);
    assert.equal(after.jobs - before.jobs, 1, 'exactly one job');
    assert.equal(after.debits - before.debits, 1, 'exactly one job_allowance_debits row');
    for (const [k, v] of Object.entries(c.want)) assert.equal(after[k] - before[k], v, `${k}: delta must be exactly ${v}`);
    assert.ok(b.sawWait, 'the loser was SEEN waiting on the lock (pg_stat_activity): the race was real');
  });
}

test('B0 AC3: sequential double tap at exactly 1 song left -> 201, then 200 with the same id; tap 2 writes nothing', { skip, timeout: 30_000 }, async () => {
  const u = await user({ jobsUsed: 4 });
  const e = await entry(u);
  as(u);
  const t1 = await remakeOf(e);
  assert.equal(t1.status, 201, JSON.stringify(t1.body));
  const mid = await b0Counts(u, e.url);
  assert.deepEqual({ ...mid, usage_rows: 0 }, { jobs: 1, debits: 1, jobs_used: 5, songs_used: 0, usage_rows: 0, burst_rows: 1 });
  // Count every statement tap 2 sends inside a transaction: there must be none.
  const txStatements = [];
  const t2 = await withHook((sql, p, run) => { txStatements.push(sql); return run(); }, () => remakeOf(e));
  assert.deepEqual([t2.status, t2.body], [200, { id: t1.body.id }], 'not 402: the quota is full, but the song already exists');
  assert.deepEqual(await b0Counts(u, e.url), mid, 'no job, debit, jobs_used, trial or burst row written by tap 2');
  assert.deepEqual(txStatements, [], 'tap 2 opened no transaction (findExisting answered before every gate)');
});

// ── B2 AC4: reorder atomic under PROVEN concurrency ─────────────────────────────────────────

const LIST_WAIT = '%FROM public.set_lists WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE%';
const ctx = (id) => ({ params: { id } });

async function fiftyList(u) {
  as(u);
  const l = await lists.POST(req({ name: `Fifty ${randomUUID().slice(0, 6)}` }, '/api/set-lists'));
  assert.equal(l.status, 201, JSON.stringify(l.body));
  const id = l.body.list.id;
  for (let i = 0; i < 50; i += 1) {
    const jid = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, youtube_url, input_kind, upload_r2_key, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint, user_id, title)
       VALUES ($1, NULL, 'upload', $2, ARRAY['drums'], 4, 'done', 'b2-conc', '', $3, $4)`,
      [jid, `uploads/${jid}`, u.user_id, `Song ${i}`],
    );
    const r = await songs.POST(req({ job_id: jid }, `/api/set-lists/${id}/songs`), ctx(id));
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  return id;
}
const listRows = async (id) =>
  (await pool.query(`SELECT item_id::text AS item_id, position FROM public.set_list_songs WHERE set_list_id = $1 ORDER BY position`, [id])).rows;
const put = (id, order) => songs.PUT(req({ order }, `/api/set-lists/${id}/songs`), ctx(id));

/**
 * Hold the FIRST transaction whose statement matches `holdAt` right after that statement ran
 * (its list lock is held, its writes are uncommitted); `started()` resolves then. `release()`
 * lets it commit.
 */
function holdFirst(holdAt) {
  let release, reached;
  const held = new Promise((r) => (release = r));
  const started = new Promise((r) => (reached = r));
  let taken = false;
  const onQuery = async (sql, params, run) => {
    const out = await run();
    if (!taken && holdAt.test(sql)) {
      taken = true;
      reached();
      await held;
    }
    return out;
  };
  return { onQuery, release: () => release(), started: () => within(started, 10_000, `never reached: ${holdAt}`) };
}

test('B2 AC4: two concurrent 50-item reorders, the second SEEN waiting on the list lock -> final = exactly one order, positions 0..49', { skip, timeout: 120_000 }, async () => {
  const u = await user();
  const id = await fiftyList(u);
  const base = (await listRows(id)).map((r) => r.item_id);
  const orderA = [...base].reverse();
  const orderB = [...base.slice(25), ...base.slice(0, 25)];
  const h = holdFirst(/UPDATE public\.set_list_songs s SET position = o\.ord - 1/);
  let a, b, sawWait;
  await withHook(h.onQuery, async () => {
    const pa = put(id, orderA);
    try {
      await h.started(); // A holds the list lock with its new positions written, uncommitted
      const pb = put(id, orderB);
      sawWait = await sawLockWait(LIST_WAIT);
      h.release();
      [a, b] = await Promise.all([pa, pb]);
    } finally {
      h.release();
      await pa.catch(() => {});
    }
  });
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  const rows = await listRows(id);
  assert.deepEqual(rows.map((r) => r.position), [...Array(50).keys()], 'positions are 0..49: unique, no gap');
  assert.deepEqual(rows.map((r) => r.item_id), orderB, 'the final order is exactly the last committed reorder, never a mix');
  assert.ok(sawWait, 'reorder B waited on the set_lists row lock while A was open (FOR UPDATE held)');
});

test('B2 AC4: a reorder racing a remove -> 409 STALE_ORDER, the list renumbered 0..48 with no gap', { skip, timeout: 120_000 }, async () => {
  const u = await user();
  const id = await fiftyList(u);
  const base = (await listRows(id)).map((r) => r.item_id);
  const gone = base[10];
  const h = holdFirst(/row_number\(\) OVER \(ORDER BY position\)/); // the remove's renumber
  let del, re, sawWait;
  await withHook(h.onQuery, async () => {
    const pd = songs.DELETE(req({ item_id: gone }, `/api/set-lists/${id}/songs`), ctx(id));
    try {
      await h.started(); // the remove holds the list lock: item deleted, rest renumbered, uncommitted
      const pr = put(id, [...base].reverse()); // still names the removed item
      sawWait = await sawLockWait(LIST_WAIT);
      h.release();
      [del, re] = await Promise.all([pd, pr]);
    } finally {
      h.release();
      await pd.catch(() => {});
    }
  });
  assert.deepEqual([del.status, del.body], [200, { removed: true }]);
  assert.deepEqual([re.status, re.body.error_code], [409, 'STALE_ORDER'], JSON.stringify(re.body));
  const rows = await listRows(id);
  assert.deepEqual(rows.map((r) => r.position), [...Array(49).keys()], 'positions are 0..48: no gap where the removed song was');
  assert.deepEqual(rows.map((r) => r.item_id), base.filter((x) => x !== gone), 'the remove kept the order; the stale reorder wrote nothing');
  assert.ok(sawWait, 'the reorder waited on the set_lists row lock held by the remove');
});

// ── B3 AC4: the cap and retried_at under concurrency ────────────────────────────────────────

const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
async function failedJob(uid, depth) {
  const jid = randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, error_code, attempts, client_ip_hash, client_fingerprint, user_id, retry_depth)
     VALUES ($1, '${CANON}', ARRAY['drums','bass'], 4, 'failed', 'FETCH_PROXY_FAILED', 1, 'b3-conc-seed', '', $2, $3)`,
    [jid, uid, depth],
  );
  return jid;
}
const retryPost = (id) => retry.POST(req({}, `/api/jobs/${id}/retry`), { params: { id } });
// No debit row (a free retry), so the parent's FOR UPDATE is the first lock the two share.
const PARENT_LOCK = (sql) => /FROM jobs WHERE id = \$1::uuid/.test(sql) && /retry_depth, retried_at/.test(sql);
const PARENT_WAIT = '%retry_depth, retried_at%FOR UPDATE%';
const MARK_RETRIED = /UPDATE jobs SET retried_at = now\(\)/;
// What a retry may have written for this user (#374): allowance debits, the jobs_used counter
// (no entitlements row = 0) and burst rows (checkBurstLimit's job_start_attempt events).
const b3Counts = (uid) => one(
  `SELECT (SELECT count(*)::int FROM job_allowance_debits WHERE user_id = $1) AS debits,
          (SELECT COALESCE(max(jobs_used), 0)::int FROM entitlements WHERE user_id = $1) AS jobs_used,
          (SELECT count(*)::int FROM usage_events WHERE user_id = $1 AND kind = 'job_start_attempt') AS burst_rows`,
  [uid],
);

test('B3 AC4: two concurrent retries of a depth-1 parent -> 1 child at depth 2, retried_at written once; its retries -> 429, never depth 3', { skip, timeout: 60_000 }, async () => {
  const u = await user();
  as(u);
  const p = await failedJob(u.user_id, 1);
  const before = await b3Counts(u.user_id);
  const b = lockBarrier(PARENT_LOCK, PARENT_WAIT);
  let marks = 0;
  const onQuery = async (sql, params, run) => {
    const r = await b.onQuery(sql, params, run);
    if (MARK_RETRIED.test(sql)) marks += r.rowCount ?? 0;
    return r;
  };
  const [x, y] = await withHook(onQuery, () => Promise.all([retryPost(p), retryPost(p)]));
  assert.equal(b.arrived, 2, "both retries passed the route's lock-free checks and reached the parent lock");
  assert.deepEqual([x.status, y.status].sort(), [200, 201], JSON.stringify([x.body, y.body]));
  assert.equal(x.body.id, y.body.id, "the loser answers with the winner's child");
  const children = (await pool.query('SELECT id::text AS id, retry_depth, created_at FROM jobs WHERE retry_of = $1', [p])).rows;
  assert.equal(children.length, 1, 'exactly one child job');
  assert.equal(children[0].id, x.body.id);
  assert.equal(children[0].retry_depth, 2);
  assert.equal(marks, 1, 'UPDATE ... SET retried_at ran with effect exactly once across both requests');
  const parent = await one('SELECT retried_at FROM jobs WHERE id = $1', [p]);
  assert.ok(parent.retried_at, 'the parent is marked retried');
  assert.equal(parent.retried_at.getTime(), children[0].created_at.getTime(), "retried_at is the winner's transaction time (set once, by it)");
  assert.ok(b.sawWait, 'the loser was SEEN waiting on the parent row lock');
  // A free retry (the parent has no job_allowance_debits row: nothing was given back) spends
  // nothing, for the winner or the loser (#374). Both passed the burst limit (each reached the
  // parent lock, after it), so each wrote exactly one burst row.
  const mid = await b3Counts(u.user_id);
  assert.equal(mid.debits - before.debits, 0, 'a free retry writes no job_allowance_debits row');
  assert.equal(mid.jobs_used, before.jobs_used, 'a free retry leaves jobs_used unchanged');
  assert.equal(mid.burst_rows - before.burst_rows, 2, 'one burst row per Try again tap, two taps');

  // The depth-2 child fails too: two concurrent retries of it are both refused, no depth 3.
  await pool.query(`UPDATE jobs SET status = 'failed', error_code = 'FETCH_PROXY_FAILED', attempts = 1 WHERE id = $1`, [children[0].id]);
  as(u);
  const capped = await Promise.all([retryPost(children[0].id), retryPost(children[0].id)]);
  for (const r of capped) assert.deepEqual([r.status, r.body.error_code], [429, 'RETRY_LIMIT'], JSON.stringify(r.body));
  // The ROUTE's cap (decideRetry cap_reached) answered both, before the lib: no burst row, no
  // write at all (#374). Without it the lib's under-lock cap would still say 429, but only after
  // checkBurstLimit had written a row per tap, so this is what pins the route's check.
  assert.deepEqual(await b3Counts(u.user_id), mid, "the route's cap refused before the burst limit: nothing written");
  assert.equal((await one('SELECT count(*)::int AS n FROM jobs WHERE retry_of = $1', [children[0].id])).n, 0);
  assert.equal((await one('SELECT max(retry_depth)::int AS d FROM jobs WHERE user_id = $1', [u.user_id])).d, 2, 'retry_depth never > 2');
  assert.equal((await one('SELECT retried_at FROM jobs WHERE id = $1', [children[0].id])).retried_at, null, 'a refused retry marks nothing');
  assert.equal((await one('SELECT retried_at FROM jobs WHERE id = $1', [p])).retried_at.getTime(), parent.retried_at.getTime(), "the parent's retried_at is unchanged");
});

// The lib's UNDER-LOCK cap on its own (#374). The route's decideRetry reads the parent lock-free
// and, at depth 2, answers 429 before the lib runs, so the test above cannot tell whether the
// lib's own `depth < RETRY_CAP` check (under the parent's FOR UPDATE) exists. Here the route is
// RACED: it reads the parent at depth 1 (eligible), and the parent reaches depth 2 (a committed
// write on another connection) after that read and before the lib's parent lock. Only the lib's
// check stands between this request and a depth-3 child, so dropping it alone turns the 429 into
// a 500 (jobs_retry_depth_range CHECK) or a depth-3 row; dropping the route's check alone fails
// the burst-row assertion in the test above.
test("B3 AC4: the lib's under-lock cap holds when the route's cap read is raced -> 429 RETRY_LIMIT, no child, nothing marked", { skip, timeout: 60_000 }, async () => {
  const u = await user();
  as(u);
  const p = await failedJob(u.user_id, 1);
  const before = await b3Counts(u.user_id);
  let raced = 0;
  const onQuery = async (sql, params, run) => {
    if (PARENT_LOCK(sql) && raced === 0) {
      raced += 1;
      // The parent is not locked yet (a free retry: no debit row, so nothing before this lock).
      await pool.query('UPDATE jobs SET retry_depth = 2 WHERE id = $1', [p]);
    }
    return run();
  };
  const r = await withHook(onQuery, () => retryPost(p));
  assert.equal(raced, 1, "the route's lock-free checks passed at depth 1 and the lib reached the parent lock");
  assert.deepEqual([r.status, r.body.error_code], [429, 'RETRY_LIMIT'], JSON.stringify(r.body));
  assert.equal((await one('SELECT count(*)::int AS n FROM jobs WHERE retry_of = $1', [p])).n, 0, 'no child job');
  assert.equal((await one('SELECT max(retry_depth)::int AS d FROM jobs WHERE user_id = $1', [u.user_id])).d, 2, 'retry_depth never > 2');
  assert.equal((await one('SELECT retried_at FROM jobs WHERE id = $1', [p])).retried_at, null, 'a refused retry marks nothing');
  const after = await b3Counts(u.user_id);
  assert.equal(after.debits - before.debits, 0, 'no debit row');
  assert.equal(after.jobs_used, before.jobs_used, 'jobs_used unchanged');
  assert.equal(after.burst_rows - before.burst_rows, 1, 'the request got past the route (its one burst row) and was refused by the lib');
});
