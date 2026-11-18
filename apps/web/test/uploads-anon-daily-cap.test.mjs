// QA track B, B-05: POST /api/uploads must cap SIGNED-OUT presigns per IP per day.
//
// Before: 10 presigns/min/IP and nothing else, so one IP could mint ~14,400 200 MB PUT URLs a
// day with no job behind any of them. Now a signed-out IP hash gets ANON_UPLOAD_DAILY_CAP (20)
// per rolling 24 h, on the same upload_rate_events table and atomic statement as the per-minute
// counter, under its own key. Signed-in callers are not counted.
//
// The REAL route, admission.ts and error-copy.ts run. The fake DB INTERPRETS the
// upload_rate_events check-and-record statement (key, window, limit are read from its params),
// so a change to the key, the window or the limit changes what the fake does.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE, SAME_ORIGIN_HEADERS } from './helpers/same-origin.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => toJs(readFileSync(join(WEB, 'src', p), 'utf8'));

const dbStub = dataUrl(`
  const S = () => globalThis.__up;
  function handle(sql, params) {
    const s = sql.replace(/\\s+/g, ' ').trim();
    if (/^INSERT INTO upload_rate_events \\(client_ip_hash\\) SELECT \\$1::text WHERE \\( SELECT COUNT\\(\\*\\) FROM upload_rate_events WHERE client_ip_hash = \\$1 AND created_at >= NOW\\(\\) - \\(\\$2::int \\* INTERVAL '1 millisecond'\\) \\) < \\$3 RETURNING id$/.test(s)) {
      const [key, windowMs, limit] = params;
      const now = S().now;
      const n = S().events.filter((e) => e.key === key && e.at >= now - windowMs).length;
      if (n >= limit) return { rows: [], rowCount: 0 };
      S().events.push({ key, at: now });
      return { rows: [{ id: S().events.length }], rowCount: 1 };
    }
    // PR #300 MF-1: the counter runs in a tx after a per-key advisory lock; MF-2: a signed-out
    // presign is recorded as presign:<ip>:<jobId>.
    if (/^SELECT pg_advisory_xact_lock/.test(s)) { S().locks.push(params[0]); return { rows: [{}], rowCount: 1 }; }
    if (/^INSERT INTO upload_rate_events \\(client_ip_hash\\) VALUES \\(\\$1\\)$/.test(s)) {
      S().presigns.push(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT COUNT\\(\\*\\)::int AS count FROM jobs WHERE status = ANY\\(\\$1\\)$/.test(s))
      return { rows: [{ count: 0 }], rowCount: 1 };
    throw new Error('fake db: unrecognised SQL: ' + s.slice(0, 160));
  }
  export const db = {
    query: async (sql, params) => handle(sql, params),
    tx: async (fn) => fn({ query: async (sql, params) => handle(sql, params) }),
  };
`);

const ERRCOPY = dataUrl(read('lib/error-copy.ts'));
const ADMISSION = dataUrl(
  read('lib/admission.ts')
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${ERRCOPY}'`),
);
const stub = {
  next: dataUrl(`
    export class NextResponse {
      constructor(body, init) { this.status = (init && init.status) || 200; }
      static json(obj, init) { const r = new NextResponse(null, init); r.body = obj; return r; }
    }
    export class NextRequest {}`),
  sentry: dataUrl(`export const captureException = () => {};`),
  clientIp: dataUrl(`export const clientIpHashOf = () => globalThis.__up.ip;`),
  auth: dataUrl(`export const getUser = async () => globalThis.__up.user;`),
  upload: dataUrl(`
    export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
    export const validateUpload = () => ({ ok: true, ext: 'mp3', contentType: 'audio/mpeg' });`),
  r2: dataUrl(`export const presignPut = async (key) => { globalThis.__up.minted.push(key); return 'https://r2.example/put'; };`),
};
const route = await import(
  dataUrl(
    read('app/api/uploads/route.ts')
      .replace(/from ['"]@\/lib\/admission['"]/g, `from '${ADMISSION}'`)
      .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${ERRCOPY}'`)
      .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${stub.clientIp}'`)
      .replace(/from ['"]@\/lib\/upload['"]/g, `from '${stub.upload}'`)
      .replace(/from ['"]@\/lib\/r2['"]/g, `from '${stub.r2}'`)
      .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${stub.auth}'`)
      .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${stub.sentry}'`)
      .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
      .replace(/from ['"]next\/server['"]/g, `from '${stub.next}'`),
  )
);

const presign = () =>
  route.POST({ json: async () => ({ filename: 'song.mp3', size: 1_000_000 }), headers: new Headers(SAME_ORIGIN_HEADERS) });
const MIN = 60_000;

beforeEach(() => {
  delete process.env.ANON_UPLOAD_DAILY_CAP;
  delete process.env.UPLOAD_RATE_LIMIT;
  globalThis.__up = { now: Date.now(), events: [], minted: [], ip: 'ip-a', user: null, locks: [], presigns: [] };
});

test('signed out: the 21st presign from one IP in 24 h is refused, spread over the day', async () => {
  for (let i = 0; i < 20; i++) {
    globalThis.__up.now += 5 * MIN; // never trips the per-minute limit
    const r = await presign();
    assert.equal(r.status, 200, `presign ${i + 1}: ${JSON.stringify(r.body)}`);
  }
  globalThis.__up.now += 5 * MIN;
  const r = await presign();
  assert.equal(r.status, 429);
  assert.equal(r.body.error_code, 'RATE_LIMITED');
  assert.match(r.body.message, /today's upload limit/);
  assert.equal(globalThis.__up.minted.length, 20, 'no URL may be minted past the cap');
});

test('the window rolls: a day later the same IP may presign again', async () => {
  for (let i = 0; i < 20; i++) {
    globalThis.__up.now += 5 * MIN;
    await presign();
  }
  globalThis.__up.now += 24 * 60 * MIN;
  assert.equal((await presign()).status, 200);
});

test('another IP has its own daily budget', async () => {
  for (let i = 0; i < 20; i++) {
    globalThis.__up.now += 5 * MIN;
    await presign();
  }
  globalThis.__up.ip = 'ip-b';
  assert.equal((await presign()).status, 200);
});

test('signed in: the daily anonymous cap does not apply', async () => {
  globalThis.__up.user = { user_id: 'u1' };
  for (let i = 0; i < 25; i++) {
    globalThis.__up.now += 5 * MIN;
    assert.equal((await presign()).status, 200);
  }
  assert.equal(globalThis.__up.events.filter((e) => e.key.startsWith('uploads-day:')).length, 0);
});

test('the daily cap is counted under its own key, separate from the per-minute counter', async () => {
  globalThis.__up.now += 5 * MIN;
  await presign();
  const keys = globalThis.__up.events.map((e) => e.key).sort();
  assert.deepEqual(keys, ['ip-a', 'uploads-day:ip-a']);
});

test('MF-2: a signed-out presign records presign:<ip>:<jobId> for the job route; signed-in does not', async () => {
  globalThis.__up.now += 5 * MIN;
  const r = await presign();
  assert.equal(r.status, 200);
  assert.deepEqual(globalThis.__up.presigns, [`presign:ip-a:${r.body.jobId}`]);
  globalThis.__up.user = { user_id: 'u1' };
  globalThis.__up.now += 5 * MIN;
  await presign();
  assert.equal(globalThis.__up.presigns.length, 1);
});

test('MF-1: each counter is taken under its own per-key advisory lock', async () => {
  globalThis.__up.now += 5 * MIN;
  await presign();
  assert.deepEqual(globalThis.__up.locks, ['ip-a', 'uploads-day:ip-a']);
});
