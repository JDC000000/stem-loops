// SEC-1 — the job-scoped GET routes enforce ownership.
//
// WHY THIS FILE EXISTS. GET /api/jobs/:id, /stems and /play-chords never called
// getUser(). Measured against production with no cookie: /api/jobs/:id answered 200
// with 60 presigned R2 URLs, and a 1-byte range request to one of them returned 206
// audio/wav. The page's sign-in redirect protects the HTML page and nothing behind it.
//
// THE RULE under test (src/lib/job-access.ts):
//   user_id NULL  (anonymous job) -> anyone holding the id may read it
//   user_id set                   -> only that user; everyone else gets the 404 a
//                                    missing job gets (not 403: that confirms the id)
//
// This runs the REAL route handlers and the REAL lib/job-access.ts. Only the network
// edges are faked: the db (which EXECUTES the id predicate rather than ignoring it, so
// a route that stopped filtering by id fails here), R2/signers, and getUser().
// The existing per-route suites stub job-access OPEN on purpose; this is the file that
// does not.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { INPUT_TRIM_URL, INPUT_TRIM_IMPORT_RE } from './helpers/input-trim.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (file) =>
  ts.transpileModule(readFileSync(join(WEB, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const JOB = '550e8400-e29b-41d4-a716-446655440000';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIX = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];

// The db fake. It answers the `jobs` lookup ONLY for the configured id, and a request
// for any other id gets no row — so "the route looked up the id it was given" is
// observable. A `jobs` query that does not name user_id would hand back a row without
// it, which `mayReadJob` reads as OWNED (fail closed), so dropping the column from a
// SELECT turns these tests red rather than opening the job.
const dbStub = dataUrl(`
  export const db = { query: async (text, params) => {
    const t = String(text);
    globalThis.__sec.queries.push(t);
    if (/FROM jobs/.test(t)) {
      const j = globalThis.__sec.job;
      if (!j || params[0] !== j.id) return { rows: [], rowCount: 0 };
      // Return only the columns the SELECT asked for, as Postgres does.
      const list = /SELECT([\\s\\S]*?)FROM jobs/.exec(t)[1];
      const row = {};
      for (const [k, v] of Object.entries(j)) {
        if (new RegExp('\\\\b' + k + '\\\\b').test(list) || (k === 'id' && /id::text/.test(list))) row[k] = v;
      }
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  } };
`);
const getUserStub = dataUrl(`export const getUser = async () => globalThis.__sec.user;`);
const nextStub = dataUrl(`
  export class NextRequest {}
  export class NextResponse {
    static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
  }
`);
const sentryStub = dataUrl(`export const captureException = () => {}; export const captureMessage = () => {};`);

async function loadRoute(file) {
  const access = dataUrl(
    toJs('src/lib/job-access.ts').replace(/from ['"]@\/lib\/auth\/supabase['"]/, `from '${getUserStub}'`),
  );
  const js = toJs(file)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/job-access['"]/g, `from '${access}'`)
    .replace(INPUT_TRIM_IMPORT_RE, `from '${INPUT_TRIM_URL}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${getUserStub}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${dataUrl('export const presignTtlSec = () => 900;')}'`)
    .replace(
      /from ['"]@\/lib\/r2['"]/g,
      `from '${dataUrl(`
        export const mintSignedUrl = async (k) => 'https://signed/' + k;
        export const mintPlayChordsSignedUrl = async (id) => 'https://signed/jobs/' + id + '/play.chords.json';
        export const PLAY_CHORDS_SIGNED_URL_TTL_SEC = 300;
        export const r2 = { send: async () => ({ Contents: ${JSON.stringify(
          SIX.map((s) => ({ Key: `${JOB}/_stems/play/${s}.opus` })),
        )} }) };
      `)}'`,
    )
    .replace(/from ['"]@aws-sdk\/client-s3['"]/g, `from '${dataUrl('export class ListObjectsV2Command { constructor(i) { this.input = i; } }')}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${dataUrl('export const checkStemListRate = async () => ({ allowed: true, error_code: null });')}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${dataUrl("export const clientIpHashOf = () => 'h';")}'`)
    .replace(/from ['"]@\/lib\/stem-keys['"]/g, `from '${dataUrl(toJs('src/lib/stem-keys.ts'))}'`)
    .replace(
      /from ['"]@\/lib\/stem-urls['"]/g,
      `from '${dataUrl("export const mintStemPlayUrl = async (id, s) => 'https://signed/' + id + '/_stems/play/' + s + '.opus';")}'`,
    );
  return import(dataUrl(js) + '#' + Math.random());
}

const ROUTES = {
  'GET /api/jobs/:id': 'src/app/api/jobs/[id]/route.ts',
  'GET /api/jobs/:id/stems': 'src/app/api/jobs/[id]/stems/route.ts',
  'GET /api/jobs/:id/play-chords': 'src/app/api/jobs/[id]/play-chords/route.ts',
};

const jobRow = (user_id) => ({
  id: JOB,
  user_id,
  status: 'done',
  expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  bpm: 120,
  musical_key: 'C major',
});
const call = (mod, id = JOB) => mod.GET({ headers: { get: () => null } }, { params: { id } });

beforeEach(() => {
  globalThis.__sec = { job: null, user: null, queries: [] };
});

for (const [name, file] of Object.entries(ROUTES)) {
  test(`${name}: an OWNED job is a 404 for a signed-out caller, and mints nothing`, async () => {
    globalThis.__sec.job = jobRow(OWNER);
    globalThis.__sec.user = null;
    const res = await call(await loadRoute(file));
    assert.equal(res.status, 404, 'a signed-out caller read an owned job');
    assert.equal(res.body.error_code, 'NOT_FOUND');
    assert.equal(JSON.stringify(res.body).includes('signed'), false, 'a URL leaked into a denial');
  });

  test(`${name}: an OWNED job is a 404 for a DIFFERENT signed-in user`, async () => {
    globalThis.__sec.job = jobRow(OWNER);
    globalThis.__sec.user = { user_id: OTHER, email: 'o@example.com' };
    const res = await call(await loadRoute(file));
    assert.equal(res.status, 404, 'another account read this job');
    assert.equal(JSON.stringify(res.body).includes('signed'), false);
  });

  test(`${name}: the OWNER gets the job`, async () => {
    globalThis.__sec.job = jobRow(OWNER);
    globalThis.__sec.user = { user_id: OWNER, email: 'a@example.com' };
    const res = await call(await loadRoute(file));
    assert.equal(res.status, 200, `owner was refused: ${JSON.stringify(res.body)}`);
  });

  test(`${name}: an ANONYMOUS job (user_id NULL) is still readable with no account`, async () => {
    globalThis.__sec.job = jobRow(null);
    globalThis.__sec.user = null;
    const res = await call(await loadRoute(file));
    assert.equal(res.status, 200, 'the anonymous start flow would break');
  });

  // Reviewer probe (merge gate): the signed-out first-run flow. An anonymous upload is
  // played AFTER sign-in, and nothing attaches the job to the account, so the caller is
  // signed in and the job is still user_id NULL.
  test(`${name}: an ANONYMOUS job is readable by a SIGNED-IN caller (upload, then sign in, then play)`, async () => {
    globalThis.__sec.job = jobRow(null);
    globalThis.__sec.user = { user_id: OTHER, email: 'o@example.com' };
    const res = await call(await loadRoute(file));
    assert.equal(res.status, 200, 'the first-run flow (anonymous upload, sign in, play) would break');
  });

  test(`${name}: a denial is byte-identical to a missing job (no existence oracle)`, async () => {
    globalThis.__sec.job = jobRow(OWNER);
    globalThis.__sec.user = null;
    const denied = await call(await loadRoute(file));
    globalThis.__sec.job = null;
    const missing = await call(await loadRoute(file));
    assert.deepEqual(denied, missing);
  });

  test(`${name}: the route asks the database for user_id (fail-closed if it stops)`, async () => {
    globalThis.__sec.job = jobRow(null);
    await call(await loadRoute(file));
    const jobsQ = globalThis.__sec.queries.find((q) => /FROM jobs/.test(q));
    assert.ok(jobsQ && /\buser_id\b/.test(/SELECT([\s\S]*?)FROM jobs/.exec(jobsQ)[1]), 'SELECT does not read user_id');
  });
}

test('GET /api/jobs/:id never puts user_id in the response, and is not cacheable', async () => {
  globalThis.__sec.job = jobRow(OWNER);
  globalThis.__sec.user = { user_id: OWNER, email: 'a@example.com' };
  const res = await call(await loadRoute(ROUTES['GET /api/jobs/:id']));
  assert.equal(res.status, 200);
  assert.equal('user_id' in res.body, false, "the owner's id was sent to the client");
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('a denied caller on an owned job learns nothing about its state (404, not NOT_READY)', async () => {
  globalThis.__sec.job = { ...jobRow(OWNER), status: 'separating' };
  globalThis.__sec.user = null;
  for (const f of [ROUTES['GET /api/jobs/:id/stems'], ROUTES['GET /api/jobs/:id/play-chords']]) {
    const res = await call(await loadRoute(f));
    assert.equal(res.body.error_code, 'NOT_FOUND', `${f} leaked job state to a non-owner`);
  }
});

// Reviewer probe (merge gate): the helper's own fail-closed claim. The route tests above
// only check that the SELECT text names user_id; `ownerId == null` passed all of them.
test('mayReadJob: a row with NO user_id column (undefined) is denied to everyone; only a literal null is anonymous', async () => {
  const access = await import(
    dataUrl(toJs('src/lib/job-access.ts').replace(/from ['"]@\/lib\/auth\/supabase['"]/, `from '${getUserStub}'`)) + '#' + Math.random()
  );
  globalThis.__sec.user = null;
  assert.equal(await access.mayReadJob(undefined), false, 'a dropped column opened the job to a signed-out caller');
  assert.equal(await access.mayReadJob(null), true);
  globalThis.__sec.user = { user_id: OWNER, email: 'a@example.com' };
  assert.equal(await access.mayReadJob(undefined), false, 'a dropped column opened the job to a signed-in caller');
  assert.equal(await access.mayReadJob(OWNER), true);
  assert.equal(await access.mayReadJob(OTHER), false);
});
