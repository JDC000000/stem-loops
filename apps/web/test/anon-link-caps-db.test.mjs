// QA track B, B-03: per-IP caps on SIGNED-OUT YouTube jobs, against a REAL Postgres.
//
// Before: the only per-visitor gate was 5 jobs/min/IP, so one script could fill the global
// in-flight cap (20) in about four minutes and every visitor got AT_CAPACITY. Now a signed-
// out IP hash may hold at most 2 non-terminal link jobs and start at most 10 per rolling 24 h.
//
// The REAL route (POST /api/jobs) and the REAL lib/admission.ts run against the migrated
// database in DATABASE_URL (CI's Tests job has one); only auth (signed out), the client IP
// (a fresh hash per test), Sentry and the signed-in-only billing modules are stubbed. The
// atomic INSERT ... WHERE is tested on its own too, with the advisory pre-check switched off,
// because that statement, not the pre-check, is what holds under a concurrent burst.
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
  pool = new Pool({ connectionString: DB_URL, max: 4 });
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
    /export async function checkAnonLinkCaps\(clientIpHash\) \{/,
    'export async function checkAnonLinkCaps(clientIpHash) { if (globalThis.__skipPrecheck) return ALLOWED;',
  );
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

async function loadRoute() {
  const admission = admissionModule();
  let js = toJs(read('src/app/api/jobs/route.ts'));
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
    };
    return `import ${clause} from '${map[spec] ?? namesStub(clause)}';`;
  });
  return import(dataUrl(js) + '#' + Math.random());
}

const HOST = 'stem-loops.com';
const post = (mod) =>
  mod.POST({
    headers: new Headers({ origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' }),
    json: async () => ({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
  });

async function freshIp() {
  const ip = `test-anon-caps-${randomUUID()}`;
  globalThis.__ipHash = ip;
  return ip;
}
async function cleanup(ip) {
  await pool.query('DELETE FROM jobs WHERE client_ip_hash = $1', [ip]);
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
delete process.env.ANON_LINK_MAX_IN_FLIGHT;
delete process.env.ANON_LINK_DAILY_CAP;
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

test('the atomic INSERT WHERE enforces both caps on its own (advisory pre-check off)', { skip }, async () => {
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
