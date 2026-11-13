// B8 — a visitor refused because the WHOLE SITE is full must be told that, not that
// they personally went too fast.
//
// The defect: admission.ts returned the same { error_code: 'RATE_LIMITED' } for the
// per-client limit (5 jobs/min from this IP) and for the global in-flight cap (20 jobs
// queued/processing across everyone). The routes turned both into 429 + "You're going a
// bit fast". With a serial worker a long queue is normal load, so the global refusal is
// the common one at launch — and it blamed the user.
//
// Instrument: the REAL admission.ts, error-copy.ts, POST /api/jobs and POST /api/uploads
// run. Only the database, R2 presign, auth, billing collaborators, Sentry and next/server
// are replaced. The fake DB answers the exact statements admission.ts issues and throws
// on anything it doesn't recognise, so it cannot silently drift from the code. A throw
// out of a route is captured as status 0 (a mutant that crashes must fail an assertion,
// not error the file out).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(WEB, 'src', p);
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => toJs(readFileSync(SRC(p), 'utf8'));

// ── fake database: the statements admission.ts and the anon INSERTs issue ──────────
const dbStub = dataUrl(`
  const F = () => globalThis.__b8;
  const ok = (rows) => ({ rows, rowCount: rows.length });
  function handle(sql, params) {
    const s = sql.replace(/\\s+/g, ' ').trim();
    const f = F();
    f.sql.push(s);
    if (/^SELECT COUNT\\(\\*\\)::int AS count FROM jobs WHERE client_ip_hash = \\$1 AND created_at/.test(s))
      return ok([{ count: f.recent }]);
    if (/^SELECT COUNT\\(\\*\\)::int AS count FROM jobs WHERE status = ANY\\(\\$1\\)$/.test(s)) {
      f.inFlightParams = params[0];
      return ok([{ count: f.inFlight }]);
    }
    if (/FROM job_events WHERE created_at >= NOW\\(\\) - INTERVAL '24 hours'/.test(s))
      return ok([{ total: '0' }]);
    if (/^INSERT INTO upload_rate_events/.test(s))
      return f.uploadAllowed ? ok([{ id: 1 }]) : { rows: [], rowCount: 0 };
    if (/^INSERT INTO jobs/.test(s)) { f.inserted.push(params[0]); return ok([{ id: params[0] }]); }
    throw new Error('fake db: unrecognised SQL: ' + s.slice(0, 120));
  }
  export const db = { query: async (sql, params) => handle(sql, params), tx: async (fn) => fn({ query: async (s, p) => handle(s, p) }) };
`);

const stub = {
  next: dataUrl(`
    export class NextResponse {
      constructor(body, init) {
        this.status = (init && init.status) || 200;
        this.headers = new Headers((init && init.headers) || {});
      }
      static json(obj, init) { const r = new NextResponse(null, init); r.body = obj; return r; }
      async json() { return this.body; }
    }
    export class NextRequest {}`),
  sentry: dataUrl(`export const captureException = () => {};`),
  clientIp: dataUrl(`export const clientIpHashOf = () => 'iphash';`),
  auth: dataUrl(`export const getUser = async () => null;`),
  ytUrl: dataUrl(`export const canonicalizeYoutubeUrl = (u) => u;`),
  upload: dataUrl(`
    export const isValidUploadKey = () => true;
    export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
    export const validateUpload = () => ({ ok: true, ext: 'mp3', contentType: 'audio/mpeg' });`),
  r2: dataUrl(`export const presignPut = async (key) => { globalThis.__b8.presigned.push(key); return 'https://r2.example/put'; };`),
  rate: dataUrl(`
    export const checkBurstLimit = async () => null; export const checkMonthlyQuota = async () => null;
    export const bumpJobsUsedWithinQuota = async () => true; export const bumpJobsUsed = async () => {}; export const rollPeriodIfStale = async () => {};`),
  ent: dataUrl(`
    export class EntitlementError extends Error {}
    export const getEntitlementSnapshot = async () => ({}); export const enforceEntitlement = async () => ({});
    export const FREE_QUOTA_EXHAUSTED_MESSAGE = 'stub'; export const billingEnforced = () => false;`),
  trial: dataUrl(`export const consumeTrialInTx = async () => ({ ok: false });`),
  credits: dataUrl(`export const consumeCreditInTx = async () => {};`),
};

const ERRCOPY = dataUrl(read('lib/error-copy.ts'));
const ADMISSION_JS = read('lib/admission.ts')
  .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
  .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${ERRCOPY}'`);
const ADMISSION = dataUrl(ADMISSION_JS);

const wire = (js) =>
  js
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${ADMISSION}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${stub.clientIp}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${stub.ytUrl}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${stub.upload}'`)
    .replace(/from ['"]@\/lib\/r2['"]/g, `from '${stub.r2}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${stub.auth}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${stub.rate}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${stub.ent}'`)
    .replace(/from ['"]@\/lib\/billing\/credits['"]/g, `from '${stub.credits}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${stub.trial}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${stub.sentry}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${stub.next}'`);

const admission = await import(ADMISSION);
const { ERROR_COPY } = await import(ERRCOPY);
const jobsRoute = await import(dataUrl(wire(read('app/api/jobs/route.ts'))));
const uploadsRoute = await import(dataUrl(wire(read('app/api/uploads/route.ts'))));

/** A fresh admission module instance (its own warn-once flag). */
let fresh = 0;
const freshAdmission = () => import(ADMISSION + '#fresh' + ++fresh);

const JOB = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001';
const call = async (route, body) => {
  try {
    const r = await route.POST({ json: async () => body, headers: new Headers() });
    return { status: r.status, headers: r.headers, body: await r.json() };
  } catch (e) {
    return { status: 0, headers: new Headers(), body: { thrown: String(e) } };
  }
};
const postUploadJob = () => call(jobsRoute, { jobId: JOB, uploadKey: `${JOB}/_input.mp3`, loop_length_bars: 4 });
const postLinkJob = () => call(jobsRoute, { url: 'https://youtu.be/dQw4w9WgXcQ', loop_length_bars: 4 });
const presign = () => call(uploadsRoute, { filename: 'song.mp3', size: 1_000_000 });

const AT_CAP_TEXT = () => `${ERROR_COPY.AT_CAPACITY.headline} ${ERROR_COPY.AT_CAPACITY.action}`;

let savedEnv;
beforeEach(() => {
  savedEnv = { cap: process.env.ADMISSION_MAX_IN_FLIGHT, yt: process.env.ALLOW_YOUTUBE_INPUT };
  delete process.env.ADMISSION_MAX_IN_FLIGHT;
  globalThis.__b8 = { recent: 0, inFlight: 0, uploadAllowed: true, sql: [], inserted: [], presigned: [], inFlightParams: null };
});
afterEach(() => {
  for (const [k, v] of [['ADMISSION_MAX_IN_FLIGHT', savedEnv.cap], ['ALLOW_YOUTUBE_INPUT', savedEnv.yt]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ───────────────────────── checkAdmission: which refusal is which ─────────────────────────

test('global cap reached → AT_CAPACITY (not RATE_LIMITED), with Retry-After seconds and copy', async () => {
  globalThis.__b8.inFlight = 20;
  const r = await admission.checkAdmission('iphash');
  assert.equal(r.allowed, false);
  assert.equal(r.error_code, 'AT_CAPACITY');
  assert.equal(r.retry_after_s, 120);
  assert.equal(r.message, AT_CAP_TEXT());
  // Counts every non-terminal status — unchanged from before B8.
  assert.deepEqual(globalThis.__b8.inFlightParams, ['queued', 'downloading', 'separating', 'extracting', 'uploading']);
});

test('the cap boundary is unchanged: 19 in flight is admitted, 20 is refused (default 20)', async () => {
  globalThis.__b8.inFlight = 19;
  assert.deepEqual(await admission.checkAdmission('iphash'), { allowed: true, error_code: null });
  globalThis.__b8.inFlight = 20;
  assert.equal((await admission.checkAdmission('iphash')).error_code, 'AT_CAPACITY');
  globalThis.__b8.inFlight = 21;
  assert.equal((await admission.checkAdmission('iphash')).error_code, 'AT_CAPACITY');
});

test('per-client limit still returns exactly { allowed:false, error_code:"RATE_LIMITED" }', async () => {
  globalThis.__b8.recent = 5;
  assert.deepEqual(await admission.checkAdmission('iphash'), { allowed: false, error_code: 'RATE_LIMITED' });
  globalThis.__b8.recent = 4;
  assert.deepEqual(await admission.checkAdmission('iphash'), { allowed: true, error_code: null });
});

test('a client over its own limit while the site is also full is told RATE_LIMITED (it is their limit too)', async () => {
  Object.assign(globalThis.__b8, { recent: 5, inFlight: 50 });
  assert.equal((await admission.checkAdmission('iphash')).error_code, 'RATE_LIMITED');
});

// ───────────────────────── ADMISSION_MAX_IN_FLIGHT ─────────────────────────

test('ADMISSION_MAX_IN_FLIGHT overrides the cap (both lower and higher than 20)', async () => {
  process.env.ADMISSION_MAX_IN_FLIGHT = '3';
  globalThis.__b8.inFlight = 2;
  assert.equal((await admission.checkAdmission('iphash')).allowed, true);
  globalThis.__b8.inFlight = 3;
  assert.equal((await admission.checkAdmission('iphash')).error_code, 'AT_CAPACITY');

  process.env.ADMISSION_MAX_IN_FLIGHT = '40';
  globalThis.__b8.inFlight = 39;
  assert.equal((await admission.checkAdmission('iphash')).allowed, true, '20 must no longer be the cap');
  globalThis.__b8.inFlight = 40;
  assert.equal((await admission.checkAdmission('iphash')).error_code, 'AT_CAPACITY');
});

test('garbage ADMISSION_MAX_IN_FLIGHT falls back to 20, and warns exactly once', async () => {
  const mod = await freshAdmission();
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (const bad of ['abc', '0', '-5', '2.5', '1e3', '20abc', 'NaN', '99999999999999999999']) {
      process.env.ADMISSION_MAX_IN_FLIGHT = bad;
      assert.equal(mod.maxInFlight(), 20, `"${bad}" must fall back to the default`);
      globalThis.__b8.inFlight = 19;
      assert.equal((await mod.checkAdmission('iphash')).allowed, true, `"${bad}": 19 admitted`);
      globalThis.__b8.inFlight = 20;
      assert.equal((await mod.checkAdmission('iphash')).error_code, 'AT_CAPACITY', `"${bad}": 20 refused`);
    }
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, 'logged once per process, not once per request');
  assert.match(warns[0], /ADMISSION_MAX_IN_FLIGHT/);
});

test('unset / empty ADMISSION_MAX_IN_FLIGHT is the silent default 20; padded integers are accepted', async () => {
  const mod = await freshAdmission();
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    delete process.env.ADMISSION_MAX_IN_FLIGHT;
    assert.equal(mod.maxInFlight(), 20);
    process.env.ADMISSION_MAX_IN_FLIGHT = '';
    assert.equal(mod.maxInFlight(), 20);
    process.env.ADMISSION_MAX_IN_FLIGHT = ' 25 ';
    assert.equal(mod.maxInFlight(), 25);
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 0, 'a missing variable is not a misconfiguration');
});

// ───────────────────────── POST /api/jobs: what the user is actually sent ─────────────────────────

test('POST /api/jobs (upload) at global capacity → 503, Retry-After: 120, AT_CAPACITY copy, no job row', async () => {
  globalThis.__b8.inFlight = 20;
  const res = await postUploadJob();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '120');
  assert.equal(res.body.error_code, 'AT_CAPACITY');
  assert.equal(res.body.message, AT_CAP_TEXT());
  assert.deepEqual(globalThis.__b8.inserted, [], 'refused before the INSERT');
});

test('POST /api/jobs (link) at global capacity → same 503 contract', async () => {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  globalThis.__b8.inFlight = 20;
  const res = await postLinkJob();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '120');
  assert.equal(res.body.error_code, 'AT_CAPACITY');
  assert.equal(res.body.message, AT_CAP_TEXT());
  assert.deepEqual(globalThis.__b8.inserted, []);
});

test('POST /api/jobs per-client limit is still 429 RATE_LIMITED with the old copy and no Retry-After', async () => {
  globalThis.__b8.recent = 5;
  const res = await postUploadJob();
  assert.equal(res.status, 429);
  assert.equal(res.body.error_code, 'RATE_LIMITED');
  assert.equal(res.body.message, "You're going a bit fast, or we're at capacity right now. Give it a minute and try again.");
  assert.equal(res.headers.get('Retry-After'), null);
});

test('POST /api/jobs under both limits still creates the job (201)', async () => {
  globalThis.__b8.inFlight = 19;
  const res = await postUploadJob();
  assert.equal(res.status, 201);
  assert.deepEqual(globalThis.__b8.inserted, [JOB]);
});

// ───────────────────────── the copy is different, and true ─────────────────────────

test('the two refusals read differently, and the capacity one does not blame the user', async () => {
  globalThis.__b8.inFlight = 20;
  const cap = await postUploadJob();
  globalThis.__b8.inFlight = 0;
  globalThis.__b8.recent = 5;
  const rl = await postUploadJob();

  assert.notEqual(cap.body.message, rl.body.message);
  assert.doesNotMatch(cap.body.message, /fast|limit|too many/i, 'site-wide load is not the user going fast');
  assert.match(cap.body.message, /at capacity/i);
  assert.match(cap.body.message, /not something you did/i);
  assert.match(cap.body.message, /few minutes/i, 'matches Retry-After: 120');
  // The rendered map (JobError) agrees with what the route sends.
  assert.ok(ERROR_COPY.AT_CAPACITY, 'ERROR_COPY has an AT_CAPACITY entry');
  assert.notDeepEqual(ERROR_COPY.AT_CAPACITY, ERROR_COPY.RATE_LIMITED);
  // RATE_LIMITED copy is untouched.
  assert.deepEqual(ERROR_COPY.RATE_LIMITED, { headline: "We're busy or you've hit the limit.", action: 'Wait a moment and try again.' });
});

// ───────────────────────── 4.5: refuse BEFORE the upload, not after ─────────────────────────

test('POST /api/uploads at global capacity → 503 AT_CAPACITY and NO presigned PUT is minted', async () => {
  globalThis.__b8.inFlight = 20;
  const res = await presign();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '120');
  assert.equal(res.body.error_code, 'AT_CAPACITY');
  assert.equal(res.body.message, AT_CAP_TEXT());
  assert.equal(res.body.uploadUrl, undefined);
  assert.deepEqual(globalThis.__b8.presigned, [], 'the browser never gets a URL to upload 200 MB to');
});

test('POST /api/uploads honours ADMISSION_MAX_IN_FLIGHT too', async () => {
  process.env.ADMISSION_MAX_IN_FLIGHT = '2';
  globalThis.__b8.inFlight = 2;
  assert.equal((await presign()).status, 503);
  globalThis.__b8.inFlight = 1;
  assert.equal((await presign()).status, 200);
});

test('POST /api/uploads below capacity still mints the presign (200)', async () => {
  globalThis.__b8.inFlight = 19;
  const res = await presign();
  assert.equal(res.status, 200);
  assert.equal(res.body.uploadUrl, 'https://r2.example/put');
  assert.equal(globalThis.__b8.presigned.length, 1);
});

test('POST /api/uploads per-IP throttle is still 429 RATE_LIMITED and runs BEFORE the capacity COUNT', async () => {
  Object.assign(globalThis.__b8, { uploadAllowed: false, inFlight: 50 });
  const res = await presign();
  assert.equal(res.status, 429);
  assert.equal(res.body.error_code, 'RATE_LIMITED');
  assert.equal(
    globalThis.__b8.sql.some((s) => /status = ANY/.test(s)),
    false,
    'a throttled flood must not reach the jobs COUNT',
  );
  assert.deepEqual(globalThis.__b8.presigned, []);
});
