// Song library + Re-make (Phase B, B1; migration 043) against a REAL Postgres: the REAL routes
// (GET /api/library, POST /api/library/remake, DELETE /api/library/:entryId) with the REAL module
// graph — create-link-job.ts (B0), admission, rate-limit, entitlements, trial, library-server —
// on the migrated database in DATABASE_URL (CI's Tests job has one). Stubbed: getUser, the
// client-IP hash (a fresh one per test, so the per-IP limit never couples tests), Sentry and
// next/server.
//
// THE B0 CARRY-OVER (reviewer): B0's "two simultaneous taps" proof used a fake that ran one
// transaction at a time. Here two Re-makes of ONE entry run on TWO pooled connections; a barrier
// holds both until both have passed findExisting AND both have reached beforeInsert's entry
// lock, so the race is real. Expected: 1 job, 1 debit, jobs_used + 1; the loser answers 200
// with the winner's id.
//
// Also: AC 1 (GET lists an entry as 'expired'), AC 4 (charges 1 / trial path / Re-make while
// queued), AC 5 (quota boundary 4/5 -> 201, 5/5 -> 402, nothing written), AC 6 (an our-fault
// failure of a Re-make job is given back by migration 042's restore), AC 7 (one row per URL),
// Remove (owner-only).
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

const LIVE_LOOKUP = /SELECT jobs\.id::text AS id FROM jobs/;
const ENTRY_LOCK = /FROM library_entries WHERE id = \$1::uuid AND user_id = \$2::uuid FOR UPDATE/;

let pool, library, remake, entryRoute, ent;
if (!skip) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, max: 12 });
  globalThis.__lbPool = pool;
  // A barrier the concurrency test arms: each named point waits until `n` callers reached it
  // (or 3 s pass, so a mutant that serialises elsewhere cannot hang the suite).
  globalThis.__lbBarrier = null;
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  process.env.ADMISSION_MAX_IN_FLIGHT = '100000'; // other suites' queued jobs share this database
  const graph = buildModuleGraph({
    name: 'library-remake-pg',
    entries: ['app/api/library/route.ts', 'app/api/library/remake/route.ts', 'app/api/library/[entryId]/route.ts', 'lib/billing/entitlements.ts'],
    overrides: {
      'lib/db.ts': `
        const wait = async (name, text) => {
          const b = globalThis.__lbBarrier;
          if (!b || !b[name] || !b[name].re.test(text)) return;
          const p = b[name];
          p.arrived += 1;
          if (p.arrived >= p.n) p.release();
          await Promise.race([p.done, new Promise((r) => setTimeout(r, 3000))]);
        };
        export const db = {
          query: async (t, p) => { await wait('outside', String(t)); return globalThis.__lbPool.query(t, p); },
          tx: async (fn) => { const c = await globalThis.__lbPool.connect();
            const client = { query: async (t, p) => { await wait('inside', String(t)); return c.query(t, p); } };
            try { await c.query('BEGIN'); const r = await fn(client); await c.query('COMMIT'); return r; }
            catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } },
        };`,
      'lib/auth/supabase.ts': 'export const getUser = async () => globalThis.__lbUser ?? null; export const deleteAuthUser = async () => {};',
      'lib/client-ip.ts': 'export const clientIpHashOf = () => globalThis.__lbIp;',
    },
    packages: {
      '@sentry/nextjs': 'export const captureException = () => {}; export const captureMessage = () => {};',
      'next/server': `export class NextResponse { static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }
        export class NextRequest {}`,
    },
  });
  library = await import(graph.url('app/api/library/route.ts'));
  remake = await import(graph.url('app/api/library/remake/route.ts'));
  entryRoute = await import(graph.url('app/api/library/[entryId]/route.ts'));
  ent = await import(graph.url('lib/billing/entitlements.ts'));
}

const EMAIL_PREFIX = 'test-web-library-b1-';
after(async () => {
  if (!pool) return;
  const like = `(SELECT id FROM public.users WHERE email LIKE '${EMAIL_PREFIX}%')`;
  await pool.query(`DELETE FROM public.jobs WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

const HOST = 'stem-loops.com';
const req = (body) => ({
  headers: new Headers({ origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' }),
  json: async () => body,
  nextUrl: new URL(`https://${HOST}/api/library/remake`),
  url: `https://${HOST}/api/library/remake`,
});
const as = (u) => {
  globalThis.__lbUser = u;
  globalThis.__lbIp = `b1-${randomUUID()}`;
  ent?._resetEntitlementCacheForTests();
};

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
const ytUrl = (v) => `https://www.youtube.com/watch?v=${v}`;
async function entry(u, { url = ytUrl(vid()), title = 'Expired song', kind = 'youtube' } = {}) {
  const r = await pool.query(
    `INSERT INTO public.library_entries (user_id, input_kind, youtube_url, original_filename, title, video_id, bpm, musical_key)
     VALUES ($1, $2, $3, $4, $5, NULL, 101, 'D minor') RETURNING id::text AS id`,
    [u.user_id, kind, kind === 'youtube' ? url : null, kind === 'upload' ? 'take.wav' : null, title],
  );
  return { id: r.rows[0].id, url };
}
async function counts(u, url) {
  const r = await pool.query(
    `SELECT (SELECT count(*)::int FROM jobs WHERE user_id = $1 AND youtube_url = $2) AS jobs,
            (SELECT count(*)::int FROM job_allowance_debits WHERE user_id = $1) AS debits,
            (SELECT COALESCE(max(jobs_used), 0)::int FROM entitlements WHERE user_id = $1) AS jobs_used,
            (SELECT COALESCE(max(songs_used), 0)::int FROM trial_grants WHERE user_id = $1) AS songs_used`,
    [u.user_id, url],
  );
  return r.rows[0];
}
const post = (u, id) => { as(u); return remake.POST(req({ entry_id: id })); };

test('AC 4: a Re-make charges exactly one song: +1 job, +1 jobs_used, +1 debit row; expires_at is the INSERT default', { skip }, async () => {
  const u = await user();
  const e = await entry(u);
  const r = await post(u, e.id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(await counts(u, e.url), { jobs: 1, debits: 1, jobs_used: 1, songs_used: 0 });
  const j = (await pool.query('SELECT status, youtube_url, user_id::text AS u, expires_at - created_at AS life FROM jobs WHERE id = $1', [r.body.id])).rows[0];
  assert.equal(j.status, 'queued');
  assert.equal(j.youtube_url, e.url);
  assert.equal(j.u, u.user_id);
  assert.equal(j.life.hours ?? j.life.days * 24, 24, 'expires_at = created_at + 24 h (the INSERT default)');
  // The entry is untouched (neither hook writes it).
  const left = (await pool.query('SELECT count(*)::int AS n FROM library_entries WHERE id = $1', [e.id])).rows[0].n;
  assert.equal(left, 1);
});

test('AC 4: the trial path spends one trial song AND records it (+1 songs_used, debit trial_song)', { skip }, async () => {
  const u = await user({ trial: true });
  const e = await entry(u);
  const r = await post(u, e.id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = await counts(u, e.url);
  assert.equal(c.jobs, 1);
  assert.equal(c.songs_used, 1);
  assert.equal(c.debits, 1);
  const d = (await pool.query('SELECT trial_song FROM job_allowance_debits WHERE job_id = $1', [r.body.id])).rows[0];
  assert.equal(d.trial_song, true);
});

test('AC 4: a Re-make while the song is queued (or done and kept) returns that job, 0 rows written', { skip }, async () => {
  const u = await user();
  const e = await entry(u);
  const first = await post(u, e.id);
  assert.equal(first.status, 201);
  const before = await counts(u, e.url);
  const burstBefore = (await pool.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [u.user_id])).rows[0].n;
  const again = await post(u, e.id);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { id: first.body.id });
  assert.deepEqual(await counts(u, e.url), before);
  const burstAfter = (await pool.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [u.user_id])).rows[0].n;
  assert.equal(burstAfter, burstBefore, 'no burst row either: findExisting answers before every gate');
  // Done and still retained is live too.
  await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [first.body.id]);
  const done = await post(u, e.id);
  assert.deepEqual([done.status, done.body.id], [200, first.body.id]);
  assert.deepEqual(await counts(u, e.url), before);
});

test('AC 4 (REAL PG concurrency, B0 carry-over): two simultaneous Re-makes of one entry -> 1 job, 1 debit', { skip }, async () => {
  const u = await user();
  const e = await entry(u);
  as(u);
  // Both requests must pass findExisting (outside the tx) before either reaches the INSERT, and
  // both must reach beforeInsert's entry lock together.
  const point = (re) => {
    let release;
    const done = new Promise((r) => { release = r; });
    return { re, n: 2, arrived: 0, release, done };
  };
  globalThis.__lbBarrier = { outside: point(LIVE_LOOKUP), inside: point(ENTRY_LOCK) };
  let results;
  try {
    results = await Promise.all([remake.POST(req({ entry_id: e.id })), remake.POST(req({ entry_id: e.id }))]);
  } finally {
    var reached = { outside: globalThis.__lbBarrier.outside.arrived, inside: globalThis.__lbBarrier.inside.arrived };
    globalThis.__lbBarrier = null;
  }
  assert.deepEqual(reached, { outside: 2, inside: 2 }, 'both requests passed findExisting and reached beforeInsert');
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 201], JSON.stringify(results.map((r) => r.body)));
  assert.equal(results[0].body.id, results[1].body.id, 'the loser answers with the winner\'s job');
  assert.deepEqual(await counts(u, e.url), { jobs: 1, debits: 1, jobs_used: 1, songs_used: 0 });
});

test('AC 5: quota boundary — 4 of 5 used -> Re-make allowed (5/5); 5 of 5 -> 402 with the existing copy, nothing written', { skip }, async () => {
  const four = await user({ jobsUsed: 4 });
  const e4 = await entry(four);
  const ok = await post(four, e4.id);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await counts(four, e4.url)).jobs_used, 5);

  const five = await user({ jobsUsed: 5 });
  const e5 = await entry(five);
  const r = await post(five, e5.id);
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.ok(typeof r.body.message === 'string' && r.body.message.length > 0, 'refusal carries copy');
  assert.deepEqual(await counts(five, e5.url), { jobs: 0, debits: 0, jobs_used: 5, songs_used: 0 });
});

test('AC 6: an our-fault failure of a Re-make job gives the song back (migration 042 restore)', { skip }, async () => {
  const u = await user();
  const e = await entry(u);
  const r = await post(u, e.id);
  assert.equal(r.status, 201);
  assert.equal((await counts(u, e.url)).jobs_used, 1);
  await pool.query("UPDATE jobs SET status = 'failed', error_code = 'FETCH_PROXY_FAILED' WHERE id = $1", [r.body.id]);
  const back = await pool.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [
    r.body.id, ['SEPARATION_FAILED', 'UPLOAD_FAILED', 'INTERNAL_ERROR', 'FETCH_PROXY_FAILED'],
  ]);
  assert.deepEqual(back.rows, [{ allowance_restored: true, trial_restored: false }]);
  assert.equal((await counts(u, e.url)).jobs_used, 0);
});

test('AC 1 + AC 7: GET /api/library lists the entry as expired, and ONE row per URL while a live job shares it', { skip }, async () => {
  const u = await user();
  const e = await entry(u, { title: 'Lucky One' });
  as(u);
  let res = await library.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries.map((x) => [x.entry_id, x.state, x.title, x.bpm, x.musical_key]), [[e.id, 'expired', 'Lucky One', 101, 'D minor']]);
  // Re-made: the live (queued) job is listed and the entry is not.
  const r = await post(u, e.id);
  as(u);
  res = await library.GET();
  assert.deepEqual(res.body.entries, [], 'the entry hides while the URL has a live job');
  assert.deepEqual(res.body.songs.filter((s) => s.youtube_url === e.url).map((s) => s.id), [r.body.id]);
  // Done and retained: still one row.
  await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [r.body.id]);
  res = await library.GET();
  assert.equal(res.body.entries.length, 0);
  // Failed: not live, so the expired entry (with its Re-make) is back beside the failed job.
  await pool.query("UPDATE jobs SET status = 'failed' WHERE id = $1", [r.body.id]);
  res = await library.GET();
  assert.deepEqual(res.body.entries.map((x) => x.entry_id), [e.id]);
  // Past retention (the sweep has not run yet): the entry is the row again.
  await pool.query("UPDATE jobs SET status = 'done', created_at = now() - interval '30 hours', expires_at = now() - interval '6 hours' WHERE id = $1", [r.body.id]);
  res = await library.GET();
  assert.deepEqual(res.body.entries.map((x) => x.entry_id), [e.id]);
  assert.ok(!res.body.songs.some((s) => s.id === r.body.id));
});

test('AC 5: another user\'s entry -> 404 and nothing spent; an upload entry -> 409', { skip }, async () => {
  const owner = await user();
  const other = await user();
  const e = await entry(owner);
  const r = await post(other, e.id);
  assert.equal(r.status, 404);
  assert.deepEqual(await counts(other, e.url), { jobs: 0, debits: 0, jobs_used: 0, songs_used: 0 });
  const up = await entry(owner, { kind: 'upload' });
  assert.equal((await post(owner, up.id)).status, 409);
});

test('AC 11: Remove deletes the owner\'s entry only', { skip }, async () => {
  const owner = await user();
  const other = await user();
  const e = await entry(owner);
  as(other);
  assert.equal((await entryRoute.DELETE(req(), { params: { entryId: e.id } })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM library_entries WHERE id = $1', [e.id])).rows[0].n, 1);
  as(owner);
  assert.equal((await entryRoute.DELETE(req(), { params: { entryId: e.id } })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM library_entries WHERE id = $1', [e.id])).rows[0].n, 0);
});

test('AC 8: account deletion (cascade) and the tombstone alone both remove entries', { skip }, async () => {
  const a = await user();
  const b = await user();
  await entry(a);
  await entry(b);
  await pool.query('DELETE FROM auth.users WHERE id = $1', [a.user_id]);
  await pool.query('UPDATE public.users SET deleted_at = now() WHERE id = $1', [b.user_id]);
  const n = (await pool.query('SELECT count(*)::int AS n FROM library_entries WHERE user_id = ANY($1::uuid[])', [[a.user_id, b.user_id]])).rows[0].n;
  assert.equal(n, 0);
});
