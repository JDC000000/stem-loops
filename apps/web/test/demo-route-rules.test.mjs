// Slice 2a — the P3.1 ROUTE-RULE TABLE, exhaustively, against the REAL route handlers and
// the REAL central rule (src/lib/job-access.ts).
//
//   route × caller {signed out, another user, the owner} × job {demo, ordinary}
//
// plus the two edge rows the rule must also hold for: an ORPHANED demo (its system account
// deleted, so user_id NULL) and an ANONYMOUS ordinary job (user_id NULL; the pre-2a rule).
//
// Every expected status below is written out literally in TABLE, so a reader can check the
// table against the design (DESIGN-PROPOSAL v1.5 P3.1) without reading the harness. The
// ordinary-job rows are the behaviour shipped before Slice 2a (SEC-1, #220; loops #233;
// download #259) and must not change.
//
// Only the network edges are faked: the db (answers by SQL text, and only for the id it was
// asked about), R2 and its signers, getUser, the entitlement tables, Next's response class.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { INPUT_TRIM_URL, INPUT_TRIM_IMPORT_RE } from './helpers/input-trim.mjs';
import { DEMO_RATE_IMPORT_RE, DEMO_RATE_URL } from './helpers/job-access-stub.mjs';
import { wirePureLibs } from './helpers/pure-libs.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (rel) => join(WEB, rel);
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const real = (rel) => dataUrl(toJs(readFileSync(P(rel), 'utf8')));

const JOB = '9c5ba587-0000-4000-8000-000000000001';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // the demo system account, or an ordinary owner
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIX = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const PLANS = {
  studio: { code: 'studio', monthly_job_quota: 150, services: [], export_stems: true, export_wav24: false },
};

const nextStub = dataUrl(`
  export class NextRequest {}
  export class NextResponse {
    static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
  }
`);
const sentryStub = dataUrl(`export const captureException = () => {}; export const captureMessage = () => {};`);
const s3Stub = dataUrl(`
  export class HeadObjectCommand { constructor(input) { this.input = input; this.kind = 'head'; } }
  export class ListObjectsV2Command { constructor(input) { this.input = input; this.kind = 'list'; } }
`);
const dbStub = dataUrl(`
  const PLANS = ${JSON.stringify(PLANS)};
  export const db = { query: async (text, params = []) => {
    const st = globalThis.__rr;
    const t = String(text);
    st.sql.push(t);
    if (/FROM jobs/.test(t)) {
      if (!st.job || params[0] !== st.job.id) return { rows: [], rowCount: 0 };
      const list = /SELECT([\\s\\S]*?)FROM jobs/.exec(t)[1];
      const row = {};
      for (const [k, v] of Object.entries(st.job)) {
        if (new RegExp('\\\\b' + k + '\\\\b').test(list)) row[k] = v;
      }
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM job_events/.test(t)) return { rows: [], rowCount: 0 };
    if (/cut_at IS NULL/.test(t)) return { rows: [{ count: 3 }], rowCount: 1 };
    if (/COUNT\\(cut_at\\)/.test(t)) return { rows: [{ total: 3, cut: 0 }], rowCount: 1 };
    if (/FROM loops/.test(t)) return { rows: [{ id: 'l1', job_id: st.job.id, stem: 'drums', section_label: 'verse', start_sec: 0, end_sec: 8, bpm: 102, cut_at: st.cutLoops ? '2026-11-18T00:00:00Z' : null, r2_key: 'jobs/' + st.job.id + '/loops/drums_verse.wav', filename: 'drums_verse.wav' }], rowCount: 1 };
    if (/INSERT INTO loop_requests/.test(t)) return { rows: [{ id: 'req-1', status: 'queued', created_at: 'now' }], rowCount: 1 };
    if (/FROM loop_requests/.test(t)) return { rows: [], rowCount: 0 };
    if (/FROM entitlements e/.test(t)) {
      return { rows: [{ plan_code: 'studio', period_start: new Date(Date.now() - 864e5).toISOString(),
        period_end: new Date(Date.now() + 864e5 * 20).toISOString(), jobs_used: 0, sub_status: 'active',
        sub_period_start: new Date(Date.now() - 864e5).toISOString() }], rowCount: 1 };
    }
    if (/v_credit_balance/.test(t)) return { rows: [{ credits_remaining: 0 }], rowCount: 1 };
    if (/trial_grants/.test(t)) return { rows: [], rowCount: 0 };
    if (/FROM plans/.test(t)) return { rows: [PLANS[params[0]] ?? PLANS.studio], rowCount: 1 };
    throw new Error('unexpected SQL in test: ' + t.slice(0, 80));
  } };
`);
const authStub = dataUrl(`export const getUser = async () => globalThis.__rr.user;`);
const r2Stub = dataUrl(`
  export const r2 = { send: async (cmd) => {
    if (cmd.kind === 'head') return {};
    return { Contents: ${JSON.stringify(SIX.map((s) => ({ Key: `${JOB}/_stems/play/${s}.opus` })))} };
  } };
  export const mintSignedUrl = async (k) => 'https://signed/' + k;
  export const mintPlayChordsSignedUrl = async (id) => 'https://signed/jobs/' + id + '/play.chords.json';
  export const PLAY_CHORDS_SIGNED_URL_TTL_SEC = 300;
`);
const stemUrlsStub = dataUrl(`
  export const mintStemPlayUrl = async (id, s) => 'https://signed/' + id + '/_stems/play/' + s + '.opus';
  export const mintStemDownloadUrl = async (id, s) => 'https://signed/' + id + '/_stems/dl/' + s + '.wav';
`);
const admissionStub = dataUrl(`export const checkStemListRate = async () => ({ allowed: true, error_code: null });`);
const clientIpStub = dataUrl(`export const clientIpHashOf = () => 'iphash';`);
const sameOriginStub = dataUrl(`export const BAD_ORIGIN = 'BAD_ORIGIN'; export const crossOriginRefusal = () => null;`);
const entitlementsUrl = dataUrl(
  toJs(readFileSync(P('src/lib/billing/entitlements.ts'), 'utf8')).replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`),
);
const jobAccessUrl = dataUrl(
  toJs(readFileSync(P('src/lib/job-access.ts'), 'utf8')).replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`),
);

async function loadRoute(rel) {
  const js = toJs(readFileSync(P(rel), 'utf8'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/r2['"]/g, `from '${r2Stub}'`)
    .replace(/from ['"]@\/lib\/job-access['"]/g, `from '${jobAccessUrl}'`)
    .replace(DEMO_RATE_IMPORT_RE, `from '${DEMO_RATE_URL}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${entitlementsUrl}'`)
    .replace(/from ['"]@\/lib\/stem-urls['"]/g, `from '${stemUrlsStub}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${admissionStub}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIpStub}'`)
    .replace(/from ['"]@\/lib\/same-origin['"]/g, `from '${sameOriginStub}'`)
    .replace(/from ['"]@\/lib\/stem-keys['"]/g, `from '${real('src/lib/stem-keys.ts')}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${dataUrl("export const presignTtlSec = () => 900; export const JOB_RETAINED_UNTIL_SQL = 'expires_at';")}'`)
    .replace(INPUT_TRIM_IMPORT_RE, `from '${INPUT_TRIM_URL}'`)
    .replace(/from ['"]@aws-sdk\/client-s3['"]/g, `from '${s3Stub}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`);
  return import(dataUrl(wirePureLibs(js)) + '#' + Math.random());
}

const req = (url = 'https://x.test/') => ({ url, headers: { get: () => null } });
const ROUTES = {
  'GET /api/jobs/:id': ['src/app/api/jobs/[id]/route.ts', (m) => m.GET(req(), { params: { id: JOB } })],
  'GET /api/jobs/:id/stems': ['src/app/api/jobs/[id]/stems/route.ts', (m) => m.GET(req(), { params: { id: JOB } })],
  'GET /api/jobs/:id/play-chords': ['src/app/api/jobs/[id]/play-chords/route.ts', (m) => m.GET(req(), { params: { id: JOB } })],
  'GET /api/jobs/:id/loops': ['src/app/api/jobs/[id]/loops/route.ts', (m) => m.GET(req(), { params: { id: JOB } })],
  'POST /api/jobs/:id/loops (cut)': ['src/app/api/jobs/[id]/loops/route.ts', (m) => m.POST(req(), { params: { id: JOB } })],
  'GET /api/jobs/:id/download (WAV)': [
    'src/app/api/jobs/[id]/download/route.ts',
    (m) => m.GET(req(`https://x.test/api/jobs/${JOB}/download?stem=drums`), { params: { id: JOB } }),
  ],
};
const mods = {};
for (const [name, [file]] of Object.entries(ROUTES)) mods[name] = await loadRoute(file);

const CALLERS = { 'signed out': null, 'another user': OTHER, owner: OWNER };
const JOBS = {
  demo: { user_id: OWNER, is_demo: true },
  ordinary: { user_id: OWNER, is_demo: false },
  'orphaned demo (owner deleted)': { user_id: null, is_demo: true },
  'anonymous ordinary job': { user_id: null, is_demo: false },
};

// THE TABLE. [signed out, another user, owner]. 401 = the download route's own "sign in
// first", which it answers before it looks the job up (unchanged).
const TABLE = {
  'GET /api/jobs/:id': {
    demo: [200, 200, 200],
    ordinary: [404, 404, 200],
    'orphaned demo (owner deleted)': [200, 200, 200],
    'anonymous ordinary job': [200, 200, 200],
  },
  'GET /api/jobs/:id/stems': {
    demo: [200, 200, 200],
    ordinary: [404, 404, 200],
    'orphaned demo (owner deleted)': [200, 200, 200],
    'anonymous ordinary job': [200, 200, 200],
  },
  'GET /api/jobs/:id/play-chords': {
    demo: [200, 200, 200],
    ordinary: [404, 404, 200],
    'orphaned demo (owner deleted)': [200, 200, 200],
    'anonymous ordinary job': [200, 200, 200],
  },
  'GET /api/jobs/:id/loops': {
    demo: [404, 404, 200],
    ordinary: [404, 404, 200],
    'orphaned demo (owner deleted)': [404, 404, 404],
    'anonymous ordinary job': [200, 200, 200],
  },
  'POST /api/jobs/:id/loops (cut)': {
    demo: [404, 404, 202],
    ordinary: [404, 404, 202],
    'orphaned demo (owner deleted)': [404, 404, 404],
    'anonymous ordinary job': [202, 202, 202],
  },
  'GET /api/jobs/:id/download (WAV)': {
    demo: [401, 404, 200],
    ordinary: [401, 404, 200],
    'orphaned demo (owner deleted)': [401, 404, 404],
    'anonymous ordinary job': [401, 200, 200],
  },
};

function arrange(jobKind, callerKind) {
  const caller = CALLERS[callerKind];
  globalThis.__rr = {
    sql: [],
    user: caller === null ? null : { user_id: caller, email: 'x@example.com' },
    job: {
      id: JOB,
      ...JOBS[jobKind],
      status: 'done',
      expires_at: '2099-12-31T00:00:00.000Z',
      title: 'Lucky Ticket',
      upload_r2_key: 'uploads/' + JOB + '/Lucky Ticket MASTER 24bit.wav',
      original_filename: 'Lucky Ticket MASTER 24bit.wav',
      youtube_url: null,
      bpm: 102,
      musical_key: 'A major',
    },
  };
}

beforeEach(() => {
  globalThis.__demoRateAllowed = undefined;
  globalThis.__demoRateCalls = 0;
});

for (const [route, rows] of Object.entries(TABLE)) {
  for (const [jobKind, expected] of Object.entries(rows)) {
    Object.keys(CALLERS).forEach((callerKind, i) => {
      test(`route-rule table: ${route} · ${jobKind} · ${callerKind} → ${expected[i]}`, async () => {
        arrange(jobKind, callerKind);
        const res = await ROUTES[route][1](mods[route]);
        assert.equal(res.status, expected[i], `${route} ${jobKind} ${callerKind}: ${JSON.stringify(res.body)}`);
        if (expected[i] === 404) {
          assert.equal(res.body.error_code, 'NOT_FOUND', 'a denial must be the missing-job 404, not a 403');
          assert.equal(JSON.stringify(res.body).includes('signed'), false, 'a denial leaked a URL');
        }
        // Who wrote what: a GET on the read routes and the loops poll writes NOTHING (B-17).
        if (route.startsWith('GET')) {
          const writes = globalThis.__rr.sql.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s));
          assert.deepEqual(writes, [], `${route} wrote on GET`);
        }
        if (res.body && typeof res.body === 'object') assert.equal('user_id' in res.body, false, 'user_id reached the client');
      });
    });
  }
}

// ── the per-IP demo read limit (P3.1 "Abuse limits") ────────────────────────────────────

for (const route of ['GET /api/jobs/:id', 'GET /api/jobs/:id/play-chords']) {
  test(`${route}: a demo read over the per-IP budget is a 429 RATE_LIMITED, not cached, no URL`, async () => {
    arrange('demo', 'signed out');
    globalThis.__demoRateAllowed = false;
    const res = await ROUTES[route][1](mods[route]);
    assert.equal(res.status, 429);
    assert.equal(res.body.error_code, 'RATE_LIMITED');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(JSON.stringify(res.body).includes('signed'), false);
    assert.equal(globalThis.__demoRateCalls, 1);
  });

  test(`${route}: an ORDINARY job never reaches the demo limiter (its behaviour is unchanged)`, async () => {
    for (const jobKind of ['ordinary', 'anonymous ordinary job', 'owned, is_demo column absent']) {
      if (jobKind === 'owned, is_demo column absent') {
        arrange('ordinary', 'owner');
        delete globalThis.__rr.job.is_demo;
      } else arrange(jobKind, 'owner');
      globalThis.__demoRateAllowed = false; // would refuse, if it were asked
      globalThis.__demoRateCalls = 0;
      const res = await ROUTES[route][1](mods[route]);
      assert.equal(res.status, 200, `${jobKind} was throttled by the demo limiter`);
      assert.equal(globalThis.__demoRateCalls, 0, `${jobKind} consulted the demo limiter`);
    }
  });

  test(`${route}: a denied ordinary job is refused BEFORE the demo limiter (no oracle, no count)`, async () => {
    arrange('ordinary', 'signed out');
    const res = await ROUTES[route][1](mods[route]);
    assert.equal(res.status, 404);
    assert.equal(globalThis.__demoRateCalls, 0);
  });
}

test('every route that reads the job SELECTs is_demo (a dropped column closes a demo, never opens a job)', () => {
  for (const [name, [file]] of Object.entries(ROUTES)) {
    const src = readFileSync(P(file), 'utf8');
    const sel = /SELECT([\s\S]*?)FROM jobs/.exec(src)?.[1] ?? '';
    assert.match(sel, /\bis_demo\b/, `${name} does not read is_demo`);
  }
});

test('fail closed: a demo row whose SELECT lost is_demo is just an owned job (404 to others)', async () => {
  arrange('demo', 'signed out');
  delete globalThis.__rr.job.is_demo; // the db fake then cannot return it
  for (const route of ['GET /api/jobs/:id', 'GET /api/jobs/:id/stems', 'GET /api/jobs/:id/play-chords']) {
    const res = await ROUTES[route][1](mods[route]);
    assert.equal(res.status, 404, `${route} opened a row without the flag`);
  }
});

test('a non-owner gets the owner\'s demo response minus exactly the owner-only fields (S1)', async () => {
  arrange('demo', 'owner');
  const owner = await ROUTES['GET /api/jobs/:id'][1](mods['GET /api/jobs/:id']);
  arrange('demo', 'signed out');
  const anon = await ROUTES['GET /api/jobs/:id'][1](mods['GET /api/jobs/:id']);
  const dropped = ['original_filename', 'upload_r2_key', 'youtube_url'];
  assert.deepEqual(Object.keys(anon.body).sort(), Object.keys(owner.body).filter((k) => !dropped.includes(k)).sort());
  assert.equal(anon.body.is_demo, true);
});

// ── F1 (review of #302): a CUT loop of a demo is never signed for anyone but its owner ──
// GET /api/jobs/:id signs every cut loop (a 24 h WAV download). For a demo that would hand
// the owner-only loop cut to the public. [signed out, another user, owner]: true = a URL.
const CUT_LOOP_URL = {
  demo: [false, false, true],
  'orphaned demo (owner deleted)': [false, false, false],
  ordinary: [null, null, true], // null = the job itself is a 404 to that caller (unchanged)
  'anonymous ordinary job': [true, true, true], // unchanged: the pre-2a anonymous-job rule
};
for (const [jobKind, row] of Object.entries(CUT_LOOP_URL)) {
  Object.keys(CALLERS).forEach((callerKind, i) => {
    const want = row[i];
    test(`cut demo loop: GET /api/jobs/:id · ${jobKind} · ${callerKind} → ${want === null ? '404' : want ? 'signed URL' : 'signed_url null'}`, async () => {
      arrange(jobKind, callerKind);
      globalThis.__rr.cutLoops = true;
      const res = await ROUTES['GET /api/jobs/:id'][1](mods['GET /api/jobs/:id']);
      if (want === null) return assert.equal(res.status, 404);
      assert.equal(res.status, 200);
      assert.equal(res.body.loops.length, 1, 'the player still needs every section row');
      const url = res.body.loops[0].signed_url;
      if (want) assert.match(String(url), /^https:\/\/signed\/jobs\/.+\/loops\/drums_verse\.wav$/);
      else assert.equal(url, null, `a ${jobKind} loop WAV was signed for ${callerKind}`);
      assert.equal(JSON.stringify(res.body).includes('https://signed/'), !!want, 'a signed URL appeared elsewhere in the body');
    });
  });
}

// ── S1: a non-owner's demo response carries no storage keys or upload metadata ──
test('S1: a demo read by a non-owner drops upload_r2_key, original_filename, youtube_url and loop r2_key/filename', async () => {
  for (const [jobKind, callerKind] of [['demo', 'signed out'], ['demo', 'another user'], ['orphaned demo (owner deleted)', 'owner']]) {
    arrange(jobKind, callerKind);
    globalThis.__rr.cutLoops = true;
    const res = await ROUTES['GET /api/jobs/:id'][1](mods['GET /api/jobs/:id']);
    assert.equal(res.status, 200);
    for (const k of ['upload_r2_key', 'original_filename', 'youtube_url']) assert.equal(k in res.body, false, `${jobKind}/${callerKind}: ${k} leaked`);
    for (const k of ['r2_key', 'filename']) assert.equal(k in res.body.loops[0], false, `${jobKind}/${callerKind}: loop ${k} leaked`);
    const body = JSON.stringify(res.body);
    assert.doesNotMatch(body, /MASTER 24bit|uploads\/|\/loops\/|\.wav/, 'storage metadata reached the public body');
    // What the player needs is all still there.
    assert.equal(res.body.title, 'Lucky Ticket');
    assert.deepEqual([res.body.loops[0].section_label, res.body.loops[0].start_sec, res.body.loops[0].end_sec, res.body.loops[0].bpm], ['verse', 0, 8, 102]);
  }
});

test('S1: the demo OWNER and every ordinary job keep the full response (fields unchanged)', async () => {
  for (const [jobKind, callerKind] of [['demo', 'owner'], ['ordinary', 'owner'], ['anonymous ordinary job', 'signed out']]) {
    arrange(jobKind, callerKind);
    globalThis.__rr.cutLoops = true;
    const res = await ROUTES['GET /api/jobs/:id'][1](mods['GET /api/jobs/:id']);
    for (const k of ['upload_r2_key', 'original_filename', 'youtube_url']) assert.equal(k in res.body, true, `${jobKind}: ${k} missing`);
    for (const k of ['r2_key', 'filename']) assert.equal(k in res.body.loops[0], true, `${jobKind}: loop ${k} missing`);
  }
});
