// QA track B, B-03/B-05 + PR #300 review MF-1/MF-2: per-IP caps on SIGNED-OUT jobs, against a
// REAL Postgres.
//
// Before: the only per-visitor gate was 5 jobs/min/IP, so one script could fill the global
// in-flight cap (20) in about four minutes and every visitor got AT_CAPACITY. Now a signed-
// out IP hash may hold at most 2 non-terminal jobs (link OR upload) and start at most 10 per
// rolling 24 h, and a signed-out upload job needs a presign record for that IP and job id.
//
// The REAL routes (POST /api/jobs, POST /api/uploads) and the REAL lib/admission.ts run
// against the migrated database in DATABASE_URL (CI's Tests job has one); only auth (signed
// out), the client IP (a fresh hash per test), R2 presigning, Sentry and the signed-in-only
// billing modules are stubbed. The locked INSERT is tested on its own (advisory pre-check
// switched off) and under PARALLEL bursts on separate connections, because that statement,
// not the pre-check, is what must hold when requests arrive together (the review measured
// 20 parallel inserts -> 15 rows before the per-IP advisory lock).
//
// Skips locally without a local DATABASE_URL; FAILS under CI=true (a skipped gate is not a pass).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (rel) => readFileSync(join(WEB, rel), 'utf8');

let pool;
if (!skip) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, max: 30 });
  globalThis.__capsPool = pool;
}
after(async () => {
  if (pool) await pool.end();
});

const dbStub = dataUrl(`
  export const db = {
    query: (t, p) => globalThis.__capsPool.query(t, p),
    tx: async (fn) => { const c = await globalThis.__capsPool.connect();
      try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } },
  };`);
const errorCopy = dataUrl(toJs(read('src/lib/error-copy.ts')));

function admissionModule() {
  let js = toJs(read('src/lib/admission.ts'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${errorCopy}'`);
  // Test switch: skip the ADVISORY pre-check so the INSERT's own WHERE is what refuses.
  js = js.replace(
    /export async function checkAnonJobCaps\(clientIpHash\) \{/,
    'export async function checkAnonJobCaps(clientIpHash) { if (globalThis.__skipPrecheck) return ALLOWED;',
  );
  js = js.replace(
    /export async function hasAnonPresign\(clientIpHash, jobId\) \{/,
    'export async function hasAnonPresign(clientIpHash, jobId) { if (globalThis.__skipPrecheck) return true;',
  );
  if (!js.includes('__skipPrecheck) return ALLOWED') || !js.includes('__skipPrecheck) return true')) {
    throw new Error('test switch did not apply: admission.ts pre-check signatures changed');
  }
  return dataUrl(js);
}

// Generic stub for the signed-in-only modules: never reached on the signed-out path.
function namesStub(clause) {
  const names = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
  return dataUrl(
    names
      .map((n) =>
        n === 'EntitlementError'
          ? 'export class EntitlementError extends Error {}'
          : /^[A-Z0-9_]+$/.test(n)
            ? `export const ${n} = 'x';`
            : `export const ${n} = async () => { throw new Error('signed-in stub ${n} reached'); };`,
      )
      .join('\n'),
  );
}

async function loadRoute(rel = 'src/app/api/jobs/route.ts') {
  const admission = admissionModule();
  let js = toJs(read(rel));
  js = js.replace(/import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"];?/g, (all, clause, spec) => {
    if (spec === 'crypto' || spec.startsWith('node:')) return all;
    const map = {
      'next/server': dataUrl(`export class NextResponse {
          constructor(b, i = {}) { this.status = i.status ?? 200; this.body = b; }
          static json(body, init = {}) { return { status: init.status ?? 200, body }; } }
        export class NextRequest {}`),
      '@sentry/nextjs': dataUrl('export const captureException = () => {};'),
      '@/lib/db': dbStub,
      '@/lib/admission': admission,
      '@/lib/error-copy': errorCopy,
      '@/lib/same-origin': dataUrl(toJs(read('src/lib/same-origin.ts'))),
      '@/lib/client-ip': dataUrl('export const clientIpHashOf = () => globalThis.__ipHash;'),
      '@/lib/youtube-url': dataUrl('export const canonicalizeYoutubeUrl = (u) => u;'),
      '@/lib/auth/supabase': dataUrl('export const getUser = async () => null;'),
      '@/lib/upload': dataUrl(`
        export const isValidUploadKey = (id, key) => key === id + '/_input.mp3';
        export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
        export const validateUpload = () => ({ ok: true, ext: 'mp3', contentType: 'audio/mpeg' });`),
      '@/lib/r2': dataUrl(`export const presignPut = async (key) => { (globalThis.__minted ??= []).push(key); return 'https://r2.test/put'; };`),
    };
    return `import ${clause} from '${map[spec] ?? namesStub(clause)}';`;
  });
  return import(dataUrl(js) + '#' + Math.random());
}

const HOST = 'stem-loops.com';
const reqOf = (body) => ({
  headers: new Headers({ origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' }),
  json: async () => body,
});
const post = (mod) => mod.POST(reqOf({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
const postUpload = (mod, jobId) => mod.POST(reqOf({ jobId, uploadKey: `${jobId}/_input.mp3` }));
const presign = (mod) => mod.POST(reqOf({ filename: 'song.mp3', size: 1000 }));
const countJobs = async (ip) =>
  (await pool.query('SELECT count(*)::int AS n FROM jobs WHERE client_ip_hash = $1', [ip])).rows[0].n;

async function freshIp() {
  const ip = `test-anon-caps-${randomUUID()}`;
  globalThis.__ipHash = ip;
  return ip;
}
async function cleanup(ip) {
  await pool.query('DELETE FROM jobs WHERE client_ip_hash = $1', [ip]);
  await pool.query(
    "DELETE FROM upload_rate_events WHERE client_ip_hash IN ($1, 'uploads-day:' || $1) OR client_ip_hash LIKE 'presign:' || $1 || ':%'",
    [ip],
  );
}
async function seed(ip, n, { status = 'done', ageHours = 1, userId = null } = {}) {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash,
                         client_fingerprint, user_id, created_at)
       VALUES ($1, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '{drums}', 4, $2, $3, '', $4,
               NOW() - ($5::int * INTERVAL '1 hour'))`,
      [randomUUID(), status, ip, userId, ageHours],
    );
  }
}

process.env.ALLOW_YOUTUBE_INPUT = 'true';
delete process.env.ANON_JOB_MAX_IN_FLIGHT;
delete process.env.ANON_JOB_DAILY_CAP;
delete process.env.ANON_UPLOAD_DAILY_CAP;
process.env.UPLOAD_RATE_LIMIT = '1000';
// The GLOBAL gates are not under test, and a shared CI database may hold other suites' queued
// jobs and cost events: lift them so they cannot decide these answers.
process.env.ADMISSION_MAX_IN_FLIGHT = '1000000';
process.env.REPLICATE_SPEND_CEILING_USD = '1000000';

test('signed out: a third in-flight link job from one IP is refused (429, in-flight copy)', { skip }, async () => {
  const ip = await freshIp();
  try {
    const mod = await loadRoute();
    assert.equal((await post(mod)).status, 201);
    assert.equal((await post(mod)).status, 201);
    const third = await post(mod);
    assert.equal(third.status, 429, JSON.stringify(third.body));
    assert.match(third.body.message, /already have songs processing/);
    const n = await pool.query('SELECT count(*)::int AS n FROM jobs WHERE client_ip_hash = $1', [ip]);
    assert.equal(n.rows[0].n, 2);
  } finally {
    await cleanup(ip);
  }
});

test('signed out: finished jobs free the in-flight slots, but 10 in 24 h is the daily cap', { skip }, async () => {
  const ip = await freshIp();
  try {
    await seed(ip, 9, { status: 'done', ageHours: 2 });
    await seed(ip, 5, { status: 'done', ageHours: 30 }); // outside the window: not counted
    const mod = await loadRoute();
    assert.equal((await post(mod)).status, 201, 'the 10th job of the day is allowed');
    await pool.query("UPDATE jobs SET status = 'done' WHERE client_ip_hash = $1", [ip]);
    const eleventh = await post(mod);
    assert.equal(eleventh.status, 429, JSON.stringify(eleventh.body));
    assert.match(eleventh.body.message, /today's limit/);
  } finally {
    await cleanup(ip);
  }
});

test('the locked INSERT WHERE enforces both caps on its own (advisory pre-check off)', { skip }, async () => {
  globalThis.__skipPrecheck = true;
  const ip = await freshIp();
  try {
    const mod = await loadRoute();
    await seed(ip, 2, { status: 'queued', ageHours: 0 });
    assert.equal((await post(mod)).status, 429, 'in-flight cap must hold in the INSERT itself');
    await pool.query("UPDATE jobs SET status = 'failed' WHERE client_ip_hash = $1", [ip]);
    await seed(ip, 8, { status: 'done', ageHours: 3 });
    assert.equal((await post(mod)).status, 429, 'daily cap must hold in the INSERT itself');
    const n = await pool.query('SELECT count(*)::int AS n FROM jobs WHERE client_ip_hash = $1', [ip]);
    assert.equal(n.rows[0].n, 10, 'no row may be inserted past a cap');
  } finally {
    globalThis.__skipPrecheck = false;
    await cleanup(ip);
  }
});

test('signed-in jobs from the same IP do not count against the signed-out caps', { skip }, async () => {
  const ip = await freshIp();
  const uid = randomUUID();
  // auth.users insert fires handle_new_user (013), which creates the public.users row.
  await pool.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uid, `${uid}@caps.test`]);
  try {
    await seed(ip, 12, { status: 'queued', ageHours: 1, userId: uid });
    const mod = await loadRoute();
    assert.equal((await post(mod)).status, 201);
  } finally {
    await cleanup(ip);
    await pool.query('DELETE FROM auth.users WHERE id = $1', [uid]);
  }
});

// ── MF-1: parallel bursts (separate pooled connections, released together) ────────────────

test('MF-1: 20 PARALLEL signed-out link POSTs from one IP admit exactly the in-flight cap (2)', { skip }, async () => {
  globalThis.__skipPrecheck = true; // only the locked INSERT stands between the burst and the table
  const ip = await freshIp();
  try {
    const mod = await loadRoute();
    const res = await Promise.all(Array.from({ length: 20 }, () => post(mod)));
    const ok = res.filter((r) => r.status === 201).length;
    assert.equal(ok, 2, `statuses: ${res.map((r) => r.status).join(',')}`);
    assert.equal(await countJobs(ip), 2);
  } finally {
    globalThis.__skipPrecheck = false;
    await cleanup(ip);
  }
});

test('MF-1: a parallel burst against the DAILY cap admits exactly what is left of it', { skip }, async () => {
  globalThis.__skipPrecheck = true;
  const ip = await freshIp();
  try {
    await seed(ip, 9, { status: 'done', ageHours: 2 });
    const mod = await loadRoute();
    const res = await Promise.all(Array.from({ length: 15 }, () => post(mod)));
    assert.equal(res.filter((r) => r.status === 201).length, 1);
    assert.equal(await countJobs(ip), 10);
  } finally {
    globalThis.__skipPrecheck = false;
    await cleanup(ip);
  }
});

test('MF-1: 30 PARALLEL signed-out presigns admit exactly ANON_UPLOAD_DAILY_CAP', { skip }, async () => {
  process.env.ANON_UPLOAD_DAILY_CAP = '5';
  const ip = await freshIp();
  globalThis.__minted = [];
  try {
    const mod = await loadRoute('src/app/api/uploads/route.ts');
    const res = await Promise.all(Array.from({ length: 30 }, () => presign(mod)));
    assert.equal(res.filter((r) => r.status === 200).length, 5, res.map((r) => r.status).join(','));
    assert.equal(globalThis.__minted.length, 5);
  } finally {
    delete process.env.ANON_UPLOAD_DAILY_CAP;
    await cleanup(ip);
  }
});

// ── MF-2: signed-out UPLOAD jobs ───────────────────────────────────────────────────────────

test('MF-2: a signed-out upload job with a key never presigned is refused (400), no row', { skip }, async () => {
  const ip = await freshIp();
  try {
    const mod = await loadRoute();
    const r = await postUpload(mod, randomUUID());
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error_code, 'UPLOAD_INVALID');
    assert.equal(await countJobs(ip), 0);
  } finally {
    await cleanup(ip);
  }
});

test('MF-2: a key presigned for ANOTHER IP is refused, even by the locked INSERT alone', { skip }, async () => {
  const other = await freshIp();
  const uploads = await loadRoute('src/app/api/uploads/route.ts');
  const p = await presign(uploads);
  assert.equal(p.status, 200);
  const ip = await freshIp();
  try {
    const mod = await loadRoute();
    assert.equal((await postUpload(mod, p.body.jobId)).status, 400);
    globalThis.__skipPrecheck = true;
    assert.equal((await postUpload(mod, p.body.jobId)).status, 429, 'the INSERT WHERE must refuse it too');
    assert.equal(await countJobs(ip), 0);
  } finally {
    globalThis.__skipPrecheck = false;
    await cleanup(ip);
    await cleanup(other);
  }
});

test('MF-2: presigned signed-out uploads get the same in-flight cap as links (3rd is 429)', { skip }, async () => {
  const ip = await freshIp();
  try {
    const uploads = await loadRoute('src/app/api/uploads/route.ts');
    const mod = await loadRoute();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await presign(uploads)).body.jobId);
    assert.equal((await postUpload(mod, ids[0])).status, 201);
    assert.equal((await post(mod)).status, 201, 'a link job shares the same two slots');
    const third = await postUpload(mod, ids[1]);
    assert.equal(third.status, 429, JSON.stringify(third.body));
    assert.match(third.body.message, /already have songs processing/);
    assert.equal(await countJobs(ip), 2);
  } finally {
    await cleanup(ip);
  }
});

test('MF-2: the daily cap counts signed-out uploads and links together', { skip }, async () => {
  const ip = await freshIp();
  try {
    await seed(ip, 10, { status: 'done', ageHours: 2 }); // ten link jobs today
    const uploads = await loadRoute('src/app/api/uploads/route.ts');
    const mod = await loadRoute();
    const { jobId } = (await presign(uploads)).body;
    const r = await postUpload(mod, jobId);
    assert.equal(r.status, 429);
    assert.match(r.body.message, /today's limit/);
  } finally {
    await cleanup(ip);
  }
});

test('MF-1+MF-2: 20 PARALLEL signed-out upload jobs (each presigned) admit exactly 2', { skip }, async () => {
  globalThis.__skipPrecheck = true;
  const ip = await freshIp();
  try {
    const uploads = await loadRoute('src/app/api/uploads/route.ts');
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await presign(uploads)).body.jobId);
    const mod = await loadRoute();
    const res = await Promise.all(ids.map((id) => postUpload(mod, id)));
    assert.equal(res.filter((r) => r.status === 201).length, 2, res.map((r) => r.status).join(','));
    assert.equal(await countJobs(ip), 2);
  } finally {
    globalThis.__skipPrecheck = false;
    await cleanup(ip);
  }
});

// ── #298 changed lib/db.ts tx (checked-out client error listener, release(err)). The per-IP
// lock relies on db.tx running BEGIN, the lock and the INSERT on ONE client and releasing
// the lock at COMMIT/ROLLBACK. Pin that against the REAL lib/db.ts, not a stub. ───────────

async function realDb() {
  const pgUrl = dataUrl(`import pg from 'file://${require.resolve('pg')}'; export const Pool = pg.Pool;`);
  const sslJs = dataUrl(toJs(read('src/lib/db-ssl.ts')));
  const js = toJs(read('src/lib/db.ts'))
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${dataUrl('export const captureException = () => {};')}'`)
    .replace(/from ['"]pg['"]/g, `from '${pgUrl}'`)
    .replace(/from ['"]\.\/db-ssl['"]/g, `from '${sslJs}'`);
  return import(dataUrl(js) + '#' + Math.random());
}
async function realLock() {
  return import(admissionModule() + '#lock' + Math.random());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('real lib/db.ts tx: lockAnonIp is held until COMMIT, so a second tx for the same IP waits', { skip }, async () => {
  const { db } = await realDb();
  const { lockAnonIp } = await realLock();
  const ip = `lock-${randomUUID()}`;
  let t1Done = 0;
  const t1 = db.tx(async (c) => {
    await lockAnonIp(c, ip);
    await c.query('SELECT pg_sleep(0.4)');
    t1Done = Date.now();
  });
  await sleep(60);
  let t2Got = 0;
  await db.tx(async (c) => {
    await lockAnonIp(c, ip);
    t2Got = Date.now();
  });
  await t1;
  assert.ok(t1Done > 0 && t2Got >= t1Done, `second tx got the lock at ${t2Got}, first committed at ${t1Done}`);
});

// #300 review R3-2 (QA-54): the check must come from ANOTHER backend. Advisory locks are
// re-entrant within one session, and pg-pool hands the same idle client straight back, so a
// second db.tx re-acquired a leaked lock on the same backend and the old version of this test
// passed with ROLLBACK deleted (review mutant P10). A plain throw takes the release() path;
// release(err) is for a broken client and is pinned in db-tx-client-errors.test.mjs.
async function heldByAnotherSession(ip) {
  const c = await pool.connect(); // the test's own pool: never the backend lib/db.ts used
  try {
    const r = await c.query(
      `SELECT pg_try_advisory_lock(hashtextextended('anon-caps:' || $1, 0)) AS got`,
      [ip],
    );
    if (r.rows[0].got) {
      await c.query(`SELECT pg_advisory_unlock(hashtextextended('anon-caps:' || $1, 0))`, [ip]);
    }
    return !r.rows[0].got;
  } finally {
    c.release();
  }
}

test('real lib/db.ts tx: a throw inside the tx rolls back, and ANOTHER session can then take the lock', { skip }, async () => {
  const { db } = await realDb();
  const { lockAnonIp } = await realLock();
  const ip = `lock-${randomUUID()}`;
  let backend = null;
  await assert.rejects(
    db.tx(async (c) => {
      await lockAnonIp(c, ip);
      backend = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // Sanity: while held, another session really is refused (so the check below can fail).
      assert.equal(await heldByAnotherSession(ip), true, 'the probe cannot see a held lock');
      throw new Error('boom inside tx');
    }),
    /boom inside tx/,
  );
  const probe = await pool.query('SELECT pg_backend_pid() AS pid');
  assert.notEqual(probe.rows[0].pid, backend, 'the probe must run on a different backend');
  assert.equal(await heldByAnotherSession(ip), false, 'the lock outlived the failed transaction (no ROLLBACK?)');
  // And the next tx for the same IP still gets it promptly.
  const t0 = Date.now();
  await db.tx(async (c) => {
    await lockAnonIp(c, ip);
  });
  assert.ok(Date.now() - t0 < 2000, 'the lock must not outlive the failed transaction');
});

test('real lib/db.ts tx: different IPs never wait on each other', { skip }, async () => {
  const { db } = await realDb();
  const { lockAnonIp } = await realLock();
  const a = `lock-${randomUUID()}`;
  const b = `lock-${randomUUID()}`;
  const slow = db.tx(async (c) => {
    await lockAnonIp(c, a);
    await c.query('SELECT pg_sleep(0.5)');
  });
  await sleep(50);
  const t0 = Date.now();
  await db.tx(async (c) => {
    await lockAnonIp(c, b);
  });
  assert.ok(Date.now() - t0 < 300, 'an unrelated IP waited for another IP\'s lock');
  await slow;
});
