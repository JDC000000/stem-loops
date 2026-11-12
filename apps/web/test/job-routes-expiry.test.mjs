// Run: pnpm --filter web test
//
// The 24-hour promise on the READ side: an expired job must 404 on every job route
// even if the worker's sweep has not reached it yet; and, on two routes, the TTL of a signed
// URL is checked against what is left of the job (see "WHAT IS NOT BOUNDED" below).
//
// WHY THIS FILE EXISTS. The existing job-route tests stub `@/lib/db` by dispatching on a
// SUBSTRING of the query text (`t.includes('FROM jobs')`), which returns its row whatever
// the WHERE clause says, and stub the signer without reading the TTL. So deleting
// `AND expires_at > now()` from GET /api/jobs/:id left the whole suite at
// 1293 / 1273 / 0 / 20 while an expired, unswept job kept serving freshly minted URLs,
// and replacing the TTL with a fixed 7 days did the same.
//
// What is different here:
//   * The fake database EXECUTES the WHERE clause. It holds job rows with real
//     `expires_at` timestamps, evaluates `id = $1` and `expires_at > now()` against them,
//     and RECORDS-AND-THROWS on any predicate it does not model, so a rewritten predicate
//     is a red test, not a silent pass. Nothing asserts on SQL text.
//   * The signer is the REAL one (lib/r2.ts, lib/stem-urls.ts with the real AWS SDK
//     presigner, offline SigV4). TTLs are read back out of the minted URL's
//     `X-Amz-Expires`, which is what a caller actually receives.
// WHAT IS NOT THE PRODUCTION PATH. Round 3 said "Only the network edges are faked" and then
// listed them; `@/lib/client-ip` was also stubbed and was not listed. Enumerated from the
// code in `loadRoutes`:
//   * the database (`@/lib/db`) is the fake above;
//   * the R2 LIST call: `r2.send` is overwritten so the stems route's ListObjectsV2 reads
//     `store.objects` (presigning, which the TTL assertions read, never touches the network);
//   * `@sentry/nextjs` (no-ops) and `next/server` (a minimal NextResponse.json);
//   * `@/lib/admission` (`checkStemListRate` always allows; a DB-backed counter, imported by
//     the stems route), `@/lib/client-ip` (`clientIpHashOf` returns the literal 'iphash';
//     imported by the stems route), and `@/lib/auth/supabase` (`getUser` returns null; imported
//     by the loops route, every fixture job being anonymous);
//   * the process environment: `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID` and
//     `R2_SECRET_ACCESS_KEY` are set to dummy values at module load and `MINIO_ENDPOINT` is
//     deleted, so the real signer produces an offline SigV4 URL for a fake account;
//   * the module graph is rewired by regex on the transpiled TypeScript (`wire`): bare
//     specifiers for the AWS SDK are resolved here, and `@/lib/*` imports point at data: URLs.
//     `retention.ts`, `r2.ts`, `stem-keys.ts` and `stem-urls.ts` are the real files.
// The claims that matter are held by mutants (apps/worker/tests/mutation/manifest.py lists the
// web ones), not by this list.
//
// WHAT IS NOT BOUNDED. "No signed URL may outlive the job it points into" is NOT a property
// this file establishes, and it is not true of the code:
//   * /api/jobs/:id and /stems are tested against a LIVE job (2 h) and a job with 90 s left.
//     /api/jobs/:id's TTL has a 60 s floor (`presignTtlSec` in lib/retention.ts), so a job
//     with less than 60 s left gets a URL that outlives it; no test here has such a job
//     (for /stems either, so its behaviour under 60 s is untested).
//   * /play-chords mints a fixed 300 s URL (`PLAY_CHORDS_SIGNED_URL_TTL_SEC`) whatever the
//     job has left. It is checked only against a job with 2 h left, where 300 s is shorter.
//     A job with 90 s left would get a URL good for 300 s.
// Both are product behaviour; this PR is tests only, so they are recorded here, not fixed.
//
// FOUR job routes carry the `expires_at > now()` predicate and all four are covered here:
// /api/jobs/:id, /stems, /play-chords and /loops (GET and POST share one `authorize`).
// Round 1 covered three; deleting the predicate from /loops left the suite green.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';

const toJs = (file) =>
  ts.transpileModule(readFileSync(join(WEB, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const resolveBare = (spec) => new URL(import.meta.resolve(spec)).href;

process.env.R2_ACCOUNT_ID = 'acct123';
process.env.R2_BUCKET_NAME = 'stem-loops-test';
process.env.R2_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
process.env.R2_SECRET_ACCESS_KEY = 'secret-secret-secret-secret';
delete process.env.MINIO_ENDPOINT;

// ───────────── the fake database: it evaluates the WHERE clause ─────────────

/**
 * Evaluate `WHERE <a> AND <b> ...` against `rows`. Every conjunct must be one this
 * function models; an unmodelled one is recorded on `unmodelled` AND thrown.
 *
 * Why record as well as throw: the routes wrap their queries in try/catch and turn a
 * throw into a 500, so a throw alone shows up as "expected 404, got 500" -- a failure,
 * but one that does not say WHY. afterEach asserts `unmodelled` is empty with the SQL.
 */
function evaluate(table, where, params, rows, now, unmodelled) {
  const conjuncts = where
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+AND\s+/i);
  let out = rows;
  for (const c of conjuncts) {
    let m;
    if ((m = /^(id|job_id) = \$(\d+)$/i.exec(c))) {
      const col = m[1].toLowerCase();
      const want = String(params[Number(m[2]) - 1]).toLowerCase();
      out = out.filter((r) => String(r[col]).toLowerCase() === want);
    } else if (table === 'jobs' && /^expires_at > now\(\)$/i.test(c)) {
      out = out.filter((r) => new Date(r.expires_at).getTime() > now);
    } else if (table === 'loops' && /^cut_at IS NULL$/i.test(c)) {
      out = out.filter((r) => r.cut_at == null);
    } else {
      const msg = `fake db cannot evaluate ${table} predicate: ${c}`;
      unmodelled.push(msg);
      throw new Error(msg);
    }
  }
  return out;
}

function makeDb(store) {
  return {
    query: async (text, params = []) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      const m = /\bFROM (jobs|job_events|loops|loop_requests) WHERE (.*?)(?: ORDER BY .*)?$/i.exec(sql);
      if (!m) {
        const msg = `fake db cannot parse: ${sql}`;
        store.unmodelled.push(msg);
        throw new Error(msg);
      }
      const table = m[1].toLowerCase();
      const rows = evaluate(table, m[2], params, store[table], Date.now(), store.unmodelled);
      // The two aggregate shapes the loops route issues; anything else returns whole rows.
      if (/^SELECT COUNT\(\*\)::int AS count FROM loops /i.test(sql)) {
        return { rows: [{ count: rows.length }], rowCount: 1 };
      }
      if (/^SELECT COUNT\(\*\)::int AS total, COUNT\(cut_at\)::int AS cut FROM loops /i.test(sql)) {
        return { rows: [{ total: rows.length, cut: rows.filter((r) => r.cut_at != null).length }], rowCount: 1 };
      }
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    },
  };
}

// ───────────── load the REAL routes over the REAL signer ─────────────

let routes;
async function loadRoutes() {
  const retention = dataUrl(toJs('src/lib/retention.ts'));
  const r2 = dataUrl(
    toJs('src/lib/r2.ts')
      .replace(/from ['"]@aws-sdk\/client-s3['"]/, `from '${resolveBare('@aws-sdk/client-s3')}'`)
      .replace(
        /from ['"]@aws-sdk\/s3-request-presigner['"]/,
        `from '${resolveBare('@aws-sdk/s3-request-presigner')}'`,
      )
      .replace(/from ['"]@\/lib\/retention['"]/, `from '${retention}'`),
  );
  const stemKeys = dataUrl(toJs('src/lib/stem-keys.ts'));
  const stemUrls = dataUrl(
    toJs('src/lib/stem-urls.ts')
      .replace(/from ['"]@aws-sdk\/client-s3['"]/, `from '${resolveBare('@aws-sdk/client-s3')}'`)
      .replace(
        /from ['"]@aws-sdk\/s3-request-presigner['"]/,
        `from '${resolveBare('@aws-sdk/s3-request-presigner')}'`,
      )
      .replace(/from ['"]@\/lib\/r2['"]/, `from '${r2}'`)
      .replace(/from ['"]@\/lib\/stem-keys['"]/, `from '${stemKeys}'`),
  );
  const db = dataUrl(`export const db = { query: (...a) => globalThis.__expiryDb.query(...a) };`);
  const sentry = dataUrl(
    `export const captureException = () => {}; export const captureMessage = () => {};`,
  );
  const next = dataUrl(`
    export class NextRequest {}
    export class NextResponse {
      static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
    }
  `);
  const admission = dataUrl(
    `export const checkStemListRate = async () => ({ allowed: true, error_code: null });`,
  );
  const clientIp = dataUrl(`export const clientIpHashOf = () => 'iphash';`);
  const supabaseAuth = dataUrl(`export const getUser = async () => null;`);
  const wire = (js) =>
    js
      .replace(/from ['"]next\/server['"]/g, `from '${next}'`)
      .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentry}'`)
      .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
      .replace(/from ['"]@\/lib\/r2['"]/g, `from '${r2}'`)
      .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retention}'`)
      .replace(/from ['"]@\/lib\/stem-keys['"]/g, `from '${stemKeys}'`)
      .replace(/from ['"]@\/lib\/stem-urls['"]/g, `from '${stemUrls}'`)
      .replace(/from ['"]@\/lib\/admission['"]/g, `from '${admission}'`)
      .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIp}'`)
      .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabaseAuth}'`)
      .replace(/from ['"]@aws-sdk\/client-s3['"]/g, `from '${resolveBare('@aws-sdk/client-s3')}'`);
  const load = (file) => import(dataUrl(wire(toJs(file))) + '#' + Math.random());
  const r2Mod = await import(r2);
  // The stems route LISTS the bucket; that is the one R2 call it makes. Presigning,
  // which is what the TTL assertions read, never touches the network.
  r2Mod.r2.send = async (cmd) => {
    globalThis.__expiryStore.listed.push(cmd.input.Prefix);
    const prefix = cmd.input.Prefix;
    return { Contents: globalThis.__expiryStore.objects.filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })) };
  };
  return {
    job: await load('src/app/api/jobs/[id]/route.ts'),
    stems: await load('src/app/api/jobs/[id]/stems/route.ts'),
    chords: await load('src/app/api/jobs/[id]/play-chords/route.ts'),
    loops: await load('src/app/api/jobs/[id]/loops/route.ts'),
  };
}

const SIX = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const H = 3600 * 1000;
let store;

/** A job row; `expiresInMs` is relative to now (negative = already expired, unswept). */
function addJob(id, expiresInMs, status = 'done') {
  const now = Date.now();
  store.jobs.push({
    id,
    status,
    user_id: null,
    input_kind: 'youtube',
    youtube_url: 'https://y/x',
    upload_r2_key: null,
    original_filename: null,
    requested_stems: ['drums'],
    loop_length_bars: 4,
    error_code: null,
    error_message_user: null,
    bpm: 120,
    musical_key: 'C major',
    created_at: new Date(now + expiresInMs - 24 * H).toISOString(),
    updated_at: new Date(now).toISOString(),
    expires_at: new Date(now + expiresInMs).toISOString(),
  });
  store.loops.push({
    id: `loop-${id}`,
    job_id: id,
    stem: 'drums',
    section_label: 'verse',
    start_sec: 0,
    end_sec: 8,
    r2_key: `${id}/drums/4bar_verse_0000.wav`,
    filename: 'drums_verse.wav',
    cut_at: new Date(now).toISOString(),
    created_at: new Date(now).toISOString(),
  });
  for (const s of SIX) store.objects.push(`${id}/_stems/play/${s}.opus`);
}

const LIVE = '550e8400-e29b-41d4-a716-446655440001';
const EXPIRED = '550e8400-e29b-41d4-a716-446655440002';
const EDGE = '550e8400-e29b-41d4-a716-446655440003';
const call = (route, id) => route.GET({}, { params: { id } });
const ttlOf = (url) => Number(new URL(url).searchParams.get('X-Amz-Expires'));

beforeEach(async () => {
  store = { jobs: [], job_events: [], loops: [], loop_requests: [], objects: [], listed: [], unmodelled: [] };
  globalThis.__expiryStore = store;
  globalThis.__expiryDb = makeDb(store);
  routes ??= await loadRoutes();
  addJob(LIVE, 2 * H);
  addJob(EXPIRED, -1 * H); // expired an hour ago, worker sweep has not reached it
  addJob(EDGE, 90 * 1000); // 90 s of life left
});

afterEach(() => {
  assert.deepEqual(
    store.unmodelled,
    [],
    'the route issued SQL the fake database does not model, so what it returned was not ' +
      'evaluated against the real predicate; extend evaluate() deliberately',
  );
});

// ─────────────────────────── GET /api/jobs/:id ───────────────────────────

test('GET /api/jobs/:id: an EXPIRED job is a 404 and mints no URL, even though its row still exists', async () => {
  assert.ok(store.jobs.some((j) => j.id === EXPIRED), 'fixture: the expired row is present');
  const res = await call(routes.job, EXPIRED);
  assert.equal(res.status, 404, `expired job answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  assert.equal(res.body.error_code, 'NOT_FOUND');
  assert.equal(JSON.stringify(res.body).includes('X-Amz-Signature'), false, 'a signed URL was served');
});

test('GET /api/jobs/:id: a live job is 200 and its signed URL does not outlive the job', async () => {
  const res = await call(routes.job, LIVE);
  assert.equal(res.status, 200);
  assert.equal(res.body.loops.length, 1);
  const ttl = ttlOf(res.body.loops[0].signed_url);
  const remaining = Math.floor((new Date(store.jobs[0].expires_at).getTime() - Date.now()) / 1000);
  assert.ok(ttl > 0, `X-Amz-Expires=${ttl}`);
  assert.ok(
    ttl <= remaining + 5,
    `the URL is valid for ${ttl}s but the job has ${remaining}s left: it outlives the objects it points at`,
  );
  assert.ok(ttl >= remaining - 5, `URL TTL ${ttl}s is far shorter than the job's ${remaining}s`);
});

test('GET /api/jobs/:id: a job about to expire gets a short URL, never the full 24h window', async () => {
  const res = await call(routes.job, EDGE);
  assert.equal(res.status, 200);
  const ttl = ttlOf(res.body.loops[0].signed_url);
  // presignTtlSec floors at 60 s by design; the property is "bounded by what is left".
  assert.ok(ttl <= 120, `90 s of life left but the URL is valid for ${ttl}s`);
});

// ───────────────────────── GET /api/jobs/:id/stems ─────────────────────────

test('GET /api/jobs/:id/stems: an EXPIRED done job is a 404 and lists nothing from R2', async () => {
  const res = await call(routes.stems, EXPIRED);
  assert.equal(res.status, 404, `expired job answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  assert.equal(res.body.error_code, 'NOT_FOUND');
  assert.deepEqual(store.listed, [], 'R2 was listed for an expired job');
});

test('GET /api/jobs/:id/stems: a live job gets six URLs, each bounded by the job lifetime and 900 s', async () => {
  const res = await call(routes.stems, LIVE);
  assert.equal(res.status, 200);
  assert.equal(res.body.stems.length, 6);
  for (const s of res.body.stems) {
    const ttl = ttlOf(s.signed_url);
    assert.ok(ttl > 0 && ttl <= 900, `${s.stem}: X-Amz-Expires=${ttl}`);
  }
});

test('GET /api/jobs/:id/stems: a URL never outlives a job that has 90 s left', async () => {
  const res = await call(routes.stems, EDGE);
  assert.equal(res.status, 200);
  for (const s of res.body.stems) {
    const ttl = ttlOf(s.signed_url);
    assert.ok(ttl <= 90, `${s.stem}: valid ${ttl}s but the job has 90 s left`);
  }
});

// ─────────────────────── GET /api/jobs/:id/play-chords ───────────────────────

test('GET /api/jobs/:id/play-chords: an EXPIRED done job is a 404 and mints no URL', async () => {
  const res = await call(routes.chords, EXPIRED);
  assert.equal(res.status, 404, `expired job answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  assert.equal(res.body.error_code, 'NOT_FOUND');
  assert.equal(res.body.signed_url, undefined);
});

test('GET /api/jobs/:id/play-chords: a live job gets a URL whose real TTL matches the advertised one', async () => {
  const res = await call(routes.chords, LIVE);
  assert.equal(res.status, 200);
  assert.equal(ttlOf(res.body.signed_url), res.body.expires_in_sec);
  assert.equal(res.body.expires_in_sec, 300);
});

// ─────────────────────── /api/jobs/:id/loops (GET and POST) ───────────────────────

test('GET /api/jobs/:id/loops: an EXPIRED job is a 404 and reports nothing about its loops', async () => {
  assert.ok(store.loops.some((l) => l.job_id === EXPIRED), 'fixture: the expired job still has loop rows');
  const res = await call(routes.loops, EXPIRED);
  assert.equal(res.status, 404, `expired job answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  assert.equal(res.body.error_code, 'NOT_FOUND');
  assert.equal(res.body.loops_total, undefined, 'loop counts of an expired job were served');
});

test('GET /api/jobs/:id/loops: a live job is 200 with its counts (the predicate lets live rows through)', async () => {
  const res = await call(routes.loops, LIVE);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  assert.equal(res.body.loops_total, 1);
  assert.equal(res.body.loops_cut, 1);
  assert.equal(res.body.loops_pending, 0);
});

test('POST /api/jobs/:id/loops: an EXPIRED job is a 404 and queues no cut', async () => {
  const res = await routes.loops.POST({}, { params: { id: EXPIRED } });
  assert.equal(res.status, 404, `expired job answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  assert.equal(res.body.error_code, 'NOT_FOUND');
  assert.deepEqual(store.loop_requests, [], 'a cut was queued against an expired job');
});

test('POST /api/jobs/:id/loops: a live job with every loop already cut is an idempotent 200', async () => {
  const res = await routes.loops.POST({}, { params: { id: LIVE } });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  assert.equal(res.body.loops_pending, 0);
});

// ───────────────── the fake database itself must be able to say no ─────────────────

test('the fake database filters on expires_at (it is not a substring dispatcher)', async () => {
  const q = (sql) => globalThis.__expiryDb.query(sql, [EXPIRED]);
  assert.equal((await q('SELECT id FROM jobs WHERE id = $1 AND expires_at > now()')).rowCount, 0);
  assert.equal((await q('SELECT id FROM jobs WHERE id = $1')).rowCount, 1);
  await assert.rejects(() => q('SELECT id FROM jobs WHERE id = $1 AND expires_at > now() - 1'), /cannot evaluate/);
  store.unmodelled.length = 0; // that rejection was the point of the assertion above
});
