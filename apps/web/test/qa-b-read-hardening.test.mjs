// QA track B: B-08 (secrets fail closed), B-10 (no shared caching of 404s / history),
// B-11 (per-IP limiter on job reads, before the database).
//
// The REAL job read routes run; the database is a counter that answers "no such job" so every
// read is a 404 (the shape a random-UUID flood produces). That is exactly the path B-10 and
// B-11 are about.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { wirePureLibs, SECRET_ENV_URL } from './helpers/pure-libs.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const require_ = createRequire(import.meta.url);

const next = dataUrl(`
  export class NextRequest {}
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = new Headers(init.headers ?? {}); }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }`);
const db = dataUrl(`export const db = { query: async () => { globalThis.__dbHits++; return { rows: [], rowCount: 0 }; } };`);
const stubs = {
  'next/server': next,
  '@sentry/nextjs': dataUrl('export const captureException = () => {};'),
  '@/lib/db': db,
  '@/lib/retention': dataUrl("export const presignTtlSec = () => 900; export const JOB_RETAINED_UNTIL_SQL = 'expires_at';"),
  '@/lib/r2': dataUrl('export const mintSignedUrl = async () => ""; export const mintPlayChordsSignedUrl = async () => ""; export const PLAY_CHORDS_SIGNED_URL_TTL_SEC = 300; export const r2 = {};'),
  '@/lib/job-access': dataUrl('export const mayReadJob = async () => true;'),
  '@/lib/input-trim': dataUrl('export const inputTrimFromEvents = () => null;'),
  '@/lib/auth/supabase': dataUrl('export const getUser = async () => null;'),
  '@/lib/admission': dataUrl('export const checkStemListRate = async () => { globalThis.__dbHits++; return { allowed: true, error_code: null }; };'),
  '@aws-sdk/client-s3': dataUrl('export class ListObjectsV2Command {}'),
  '@/lib/stem-urls': dataUrl('export const mintStemPlayUrl = async () => "";'),
  '@/lib/stem-keys': dataUrl(toJs(read('src/lib/stem-keys.ts'))),
};

async function load(rel) {
  let js = wirePureLibs(toJs(read(rel)));
  js = js.replace(/from ['"]([^'"]+)['"]/g, (all, spec) => (stubs[spec] ? `from '${stubs[spec]}'` : all));
  return import(dataUrl(js) + '#' + Math.random());
}

const JOB = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const req = (ip = '198.51.100.7') => ({ headers: new Headers({ 'x-forwarded-for': ip }), cookies: { get: () => undefined } });
const ROUTES = [
  ['GET /api/jobs/:id', 'src/app/api/jobs/[id]/route.ts', true],
  ['GET /api/jobs/:id/play-chords', 'src/app/api/jobs/[id]/play-chords/route.ts', true],
  ['GET /api/jobs/:id/loops', 'src/app/api/jobs/[id]/loops/route.ts', true],
  ['GET /api/jobs/:id/stems', 'src/app/api/jobs/[id]/stems/route.ts', false],
];

let saved;
beforeEach(() => {
  globalThis.__dbHits = 0;
  saved = { ...process.env };
  delete process.env.JOB_READ_RATE_LIMIT;
});
afterEach(() => {
  for (const k of ['JOB_READ_RATE_LIMIT', 'NODE_ENV', 'IP_HASH_KEY', 'HISTORY_COOKIE_KEY']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

for (const [name, rel] of ROUTES) {
  test(`B-10: ${name} 404s (bad id and missing job) are private, no-store`, async () => {
    const mod = await load(rel);
    for (const id of ['not-a-uuid', JOB]) {
      const res = await mod.GET(req(), { params: { id } });
      assert.equal(res.status, 404, `${id}: ${JSON.stringify(res.body)}`);
      assert.equal(res.headers.get('cache-control'), 'private, no-store', id);
    }
  });
}

for (const [name, rel, limited] of ROUTES.filter((r) => r[2])) {
  test(`B-11: ${name} is limited per IP BEFORE the database (429 + Retry-After, no-store)`, async () => {
    process.env.JOB_READ_RATE_LIMIT = '3';
    const mod = await load(rel);
    for (let i = 0; i < 3; i++) assert.equal((await mod.GET(req(), { params: { id: JOB } })).status, 404);
    const hitsBefore = globalThis.__dbHits;
    const res = await mod.GET(req(), { params: { id: JOB } });
    assert.equal(res.status, 429, JSON.stringify(res.body));
    assert.equal(res.body.error_code, 'RATE_LIMITED');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(globalThis.__dbHits, hitsBefore, 'a refused read must not touch the database');
    // Another IP is unaffected.
    assert.equal((await mod.GET(req('203.0.113.9'), { params: { id: JOB } })).status, 404);
    void limited;
  });
}

test('B-11: the limiter window resets after 60 s and bounds its memory', async () => {
  const lim = await import(dataUrl(toJs(read('src/lib/read-rate-limit.ts'))) + '#w');
  process.env.JOB_READ_RATE_LIMIT = '2';
  assert.equal(lim.admitJobRead('k', 0), true);
  assert.equal(lim.admitJobRead('k', 1), true);
  assert.equal(lim.admitJobRead('k', 2), false);
  assert.equal(lim.admitJobRead('k', 60_000), true);
  for (let i = 0; i < 25_000; i++) lim.admitJobRead('flood-' + i, 100_000);
  assert.equal(lim.admitJobRead('k', 100_001), true, 'still works after a flood of distinct keys');
});

test('B-10: GET /api/history answers private, no-store', async () => {
  const mod = await load('src/app/api/history/route.ts');
  const res = await mod.GET(req());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

// ── B-08: secrets fail closed in production ──────────────────────────────────────────────
const secretEnv = () => import(SECRET_ENV_URL + '#' + Math.random());

test('B-08: IP_HASH_KEY / HISTORY_COOKIE_KEY unset or blank in production THROW', async () => {
  const s = await secretEnv();
  process.env.NODE_ENV = 'production';
  for (const v of [undefined, '', '   ']) {
    if (v === undefined) {
      delete process.env.IP_HASH_KEY;
      delete process.env.HISTORY_COOKIE_KEY;
    } else {
      process.env.IP_HASH_KEY = v;
      process.env.HISTORY_COOKIE_KEY = v;
    }
    assert.throws(() => s.ipHashKey(), /IP_HASH_KEY is not set/);
    assert.throws(() => s.historyCookieKey(), /HISTORY_COOKIE_KEY is not set/);
  }
});

test('B-08: set in production -> the real value; unset outside production -> the dev default', async () => {
  const s = await secretEnv();
  process.env.NODE_ENV = 'production';
  process.env.IP_HASH_KEY = 'k1';
  process.env.HISTORY_COOKIE_KEY = 'k2';
  assert.equal(s.ipHashKey(), 'k1');
  assert.equal(s.historyCookieKey(), 'k2');
  process.env.NODE_ENV = 'test';
  delete process.env.IP_HASH_KEY;
  delete process.env.HISTORY_COOKIE_KEY;
  assert.equal(s.ipHashKey(), 'dev-key');
  assert.equal(s.historyCookieKey(), 'dev');
});

test('B-08: the real client-ip hashes with the key, and refuses in production without one', async () => {
  const js = toJs(read('src/lib/client-ip.ts')).replace(/from ['"]@\/lib\/secret-env['"]/g, `from '${SECRET_ENV_URL}'`);
  const ip = await import(dataUrl(js) + '#' + Math.random());
  const { createHash } = await import('node:crypto');
  process.env.NODE_ENV = 'production';
  process.env.IP_HASH_KEY = 'secret';
  assert.equal(ip.hashIp('1.2.3.4'), createHash('sha256').update('secret1.2.3.4').digest('hex'));
  delete process.env.IP_HASH_KEY;
  assert.throws(() => ip.hashIp('1.2.3.4'), /IP_HASH_KEY/);
});

test('B-08: no route or lib still carries a public fallback for these secrets', () => {
  const { execFileSync } = require_('node:child_process');
  let hits = '';
  try {
    hits = execFileSync('grep', ['-rnE', "(IP_HASH_KEY|HISTORY_COOKIE_KEY) \\?\\?", join(WEB, 'src')], { encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  assert.equal(hits.trim(), '');
});
