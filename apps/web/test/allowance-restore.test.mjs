// QA-64: a signed-in link job that fails for OUR reasons gives back exactly what it spent
// (the monthly-allowance unit and, on the trial path, the trial song), once.
//
// Web's half, pinned here:
//   1. recordAllowanceDebit() (lib/billing/rate-limit.ts) writes the record in a SAVEPOINT of
//      the jobs-INSERT tx; a database without migration 042 (42P01) is tolerated, nothing else.
//   2. The "didn't count" sentence is the worker's, appended to the stored message only when
//      the worker actually gave the unit back; web copy is the same text (pinned identical)
//      and failedJobMessage() keeps it when its own copy overrides the stored message.
//   3. Against a REAL Postgres (CI only): the row web writes is the row the worker's
//      restore_job_allowance() (migration 042) reads, end to end.
//
// The DB part skips locally without a local DATABASE_URL and FAILS under CI=true (a skipped
// gate is not a pass). Never point it at a shared database: it INSERTs into auth.users.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..', '..');
const require = createRequire(join(WEB, 'package.json'));
const read = (rel) => readFileSync(join(WEB, rel), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const errorCopy = await import(dataUrl(toJs(read('src/lib/error-copy.ts'))));
const { USAGE_RETURNED_SENTENCES, failedJobMessage, ERROR_COPY } = errorCopy;

const dbStub = dataUrl(`
  export const db = {
    query: (t, p) => globalThis.__restorePool.query(t, p),
    tx: async (fn) => { const c = await globalThis.__restorePool.connect();
      try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } },
  };`);
const entStub = dataUrl(`
  export const getEntitlementSnapshot = async () => { throw new Error('not used here'); };
  export const isPeriodStale = () => false;`);
const rate = await import(
  dataUrl(
    toJs(read('src/lib/billing/rate-limit.ts'))
      .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
      .replace(/from ['"]\.\/entitlements['"]/g, `from '${entStub}'`),
  )
);

// ── 2. Copy ────────────────────────────────────────────────────────────────

function workerSentence(name) {
  const py = readFileSync(join(REPO, 'apps/worker/src/worker/job_failure.py'), 'utf8');
  const m = py.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'));
  assert.ok(m, `${name} not found in job_failure.py`);
  return m[1];
}

test('web and worker say the same sentence, in the same order (allowance, trial)', () => {
  assert.deepEqual(USAGE_RETURNED_SENTENCES, [
    workerSentence('ALLOWANCE_RETURNED_SENTENCE'),
    workerSentence('TRIAL_RETURNED_SENTENCE'),
  ]);
});

test('each returned sentence is one sentence, plain, and says nothing about credits', () => {
  for (const s of USAGE_RETURNED_SENTENCES) {
    assert.equal(s.split(/(?<=[.!?])\s+(?=[A-Z])/).length, 1, s);
    assert.match(s, /^[A-Z].*\.$/, s);
    assert.doesNotMatch(s, /credit|refund|charged|[A-Z]{2,}_[A-Z]/i, s);
  }
});

test('fixed copy never claims the song came back (it is true only per job)', () => {
  for (const [code, { headline, action }] of Object.entries(ERROR_COPY)) {
    for (const s of USAGE_RETURNED_SENTENCES) {
      assert.ok(!`${headline} ${action}`.includes(s), `${code} states "${s}" unconditionally`);
    }
    assert.doesNotMatch(`${headline} ${action}`, /didn.t count toward/i, code);
  }
});

test('failedJobMessage: the stored sentence is shown as stored (FETCH_PROXY_FAILED and others)', () => {
  const stored = `Something went wrong on our end fetching this video. Try again later. ${USAGE_RETURNED_SENTENCES[0]}`;
  assert.equal(failedJobMessage({ error_code: 'FETCH_PROXY_FAILED', error_message_user: stored }), stored);
  const plain = 'Something went wrong on our end fetching this video. Try again later.';
  assert.equal(failedJobMessage({ error_code: 'FETCH_PROXY_FAILED', error_message_user: plain }), plain);
});

test('failedJobMessage: an overriding code keeps the returned sentence only when the worker stored it', () => {
  const base = `${ERROR_COPY.SEPARATION_FAILED.headline} ${ERROR_COPY.SEPARATION_FAILED.action}`;
  for (const s of USAGE_RETURNED_SENTENCES) {
    assert.equal(
      failedJobMessage({ error_code: 'SEPARATION_FAILED', error_message_user: `Stem separation failed. ${s}` }),
      `${base} ${s}`,
    );
  }
  assert.equal(failedJobMessage({ error_code: 'SEPARATION_FAILED', error_message_user: 'Stem separation failed.' }), base);
  assert.equal(failedJobMessage({ error_code: 'SEPARATION_FAILED', error_message_user: null }), base);
});

// ── 1. recordAllowanceDebit, with a fake client ────────────────────────────

function fakeClient(onInsert) {
  const sql = [];
  return {
    sql,
    query: async (text, params) => {
      sql.push(text.trim().split(/\s+/).slice(0, 4).join(' '));
      if (/INSERT INTO public\.job_allowance_debits/.test(text)) {
        sql.push(JSON.stringify(params));
        return onInsert();
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('recordAllowanceDebit: INSERT inside a savepoint, released, true', async () => {
  const c = fakeClient(() => ({ rows: [], rowCount: 1 }));
  assert.equal(await rate.recordAllowanceDebit(c, 'u1', 'j1', { trialSong: true }), true);
  assert.equal(c.sql[0], 'SAVEPOINT job_allowance_debit');
  assert.match(c.sql[1], /^INSERT INTO public.job_allowance_debits/);
  assert.equal(c.sql[2], JSON.stringify(['j1', 'u1', true]));
  assert.equal(c.sql[3], 'RELEASE SAVEPOINT job_allowance_debit');
});

test('recordAllowanceDebit: table missing (42P01, migration 042 not applied) -> rolled back to the savepoint, false', async () => {
  const c = fakeClient(() => {
    throw Object.assign(new Error('relation "public.job_allowance_debits" does not exist'), { code: '42P01' });
  });
  assert.equal(await rate.recordAllowanceDebit(c, 'u1', 'j1', { trialSong: false }), false);
  assert.equal(c.sql.at(-1), 'ROLLBACK TO SAVEPOINT job_allowance_debit');
});

test('recordAllowanceDebit: any other error is raised (fails the jobs-INSERT tx)', async () => {
  const c = fakeClient(() => {
    throw Object.assign(new Error('permission denied'), { code: '42501' });
  });
  await assert.rejects(rate.recordAllowanceDebit(c, 'u1', 'j1', { trialSong: false }), /permission denied/);
  assert.ok(!c.sql.includes('RELEASE SAVEPOINT job_allowance_debit'));
});

// ── 3. Real Postgres: web writes, worker function restores ─────────────────

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
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  globalThis.__restorePool = pool;
}
const EMAIL_PREFIX = 'test-web-allowance-restore-';
async function cleanup() {
  const like = `(SELECT id FROM public.users WHERE email LIKE '${EMAIL_PREFIX}%')`;
  await pool.query(`DELETE FROM public.jobs WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'`);
}
after(async () => {
  if (pool) {
    await cleanup();
    await pool.end();
  }
});

const OUR_FAULT = ['SEPARATION_FAILED', 'UPLOAD_FAILED', 'INTERNAL_ERROR', 'FETCH_PROXY_FAILED'];

async function linkJob({ trial }) {
  const uid = randomUUID();
  await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [uid, `${EMAIL_PREFIX}${uid.slice(0, 8)}@example.test`]);
  if (trial) await pool.query('INSERT INTO public.trial_grants (user_id) VALUES ($1)', [uid]);
  const jid = randomUUID();
  const { db } = await import(dbStub);
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint, user_id)
       VALUES ($1, 'https://youtu.be/dQw4w9WgXcQ', ARRAY['drums'], 4, 'queued', 'qa64-web', '', $2)`,
      [jid, uid],
    );
    if (trial) await c.query('UPDATE public.trial_grants SET songs_used = songs_used + 1 WHERE user_id = $1', [uid]);
    await rate.rollPeriodIfStale(c, uid);
    await rate.bumpJobsUsed(c, uid);
    assert.equal(await rate.recordAllowanceDebit(c, uid, jid, { trialSong: trial }), true);
  });
  return { uid, jid };
}

const jobsUsed = async (uid) =>
  (await pool.query('SELECT jobs_used FROM public.entitlements WHERE user_id = $1', [uid])).rows[0].jobs_used;
const songsUsed = async (uid) =>
  (await pool.query('SELECT songs_used FROM public.trial_grants WHERE user_id = $1', [uid])).rows[0].songs_used;
const fail = (jid, code) =>
  pool.query(`UPDATE jobs SET status = 'failed', error_code = $2 WHERE id = $1`, [jid, code]);
const restore = async (jid) =>
  (await pool.query('SELECT * FROM public.restore_job_allowance($1::uuid, $2::text[])', [jid, OUR_FAULT])).rows;

test('DB: the row web records carries the period the unit was counted in', { skip }, async () => {
  const { uid, jid } = await linkJob({ trial: false });
  const r = await pool.query(
    `SELECT d.user_id, d.trial_song, d.allowance_period_start = e.period_start AS same_period, d.restored_at
       FROM public.job_allowance_debits d JOIN public.entitlements e ON e.user_id = d.user_id
      WHERE d.job_id = $1`,
    [jid],
  );
  assert.deepEqual(r.rows, [{ user_id: uid, trial_song: false, same_period: true, restored_at: null }]);
});

test('DB: web record -> our-fault failure -> worker function gives the monthly song back, once', { skip }, async () => {
  const { uid, jid } = await linkJob({ trial: false });
  assert.equal(await jobsUsed(uid), 1);
  await fail(jid, 'FETCH_PROXY_FAILED');
  assert.deepEqual(await restore(jid), [{ allowance_restored: true, trial_restored: false }]);
  assert.equal(await jobsUsed(uid), 0);
  assert.deepEqual(await restore(jid), [], 'a second call gives nothing more');
  assert.equal(await jobsUsed(uid), 0);
});

test('DB: trial path -> both the trial song and the allowance unit come back', { skip }, async () => {
  const { uid, jid } = await linkJob({ trial: true });
  assert.equal(await songsUsed(uid), 1);
  await fail(jid, 'INTERNAL_ERROR');
  assert.deepEqual(await restore(jid), [{ allowance_restored: true, trial_restored: true }]);
  assert.equal(await songsUsed(uid), 0);
  assert.equal(await jobsUsed(uid), 0);
});

test('DB: user-fault failure (DOWNLOAD_PRIVATE) -> nothing comes back', { skip }, async () => {
  const { uid, jid } = await linkJob({ trial: false });
  await fail(jid, 'DOWNLOAD_PRIVATE');
  assert.deepEqual(await restore(jid), []);
  assert.equal(await jobsUsed(uid), 1);
});
