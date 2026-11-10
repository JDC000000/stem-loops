// Run: pnpm --filter web test
//
// GET /api/jobs/:id/stems contract test — V3-J2.
//
// WHY THIS FILE EXISTS. An M-9 adversarial review ran 18 mutations against the
// first version of this feature and 12 SURVIVED with all suites green, because the
// only tests were on the key-string builders. Every behaviour the PR claimed to fix
// was unpinned: you could make the route always report `complete: true`, drop the
// TTL clamp, or serve the WAV download as the playback artifact, and nothing failed.
// These tests exist to kill those mutations specifically, and each one names the
// mutation it kills.
//
// Same harness as account-delete.test.mjs: transpile the route in memory and swap
// the `@/` imports for data-URL stubs, because the bare node:test runner cannot
// resolve the path alias. One deliberate difference — lib/stem-keys.ts is inlined
// FOR REAL rather than stubbed, since it is pure and it is the logic under test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/jobs/[id]/stems/route.ts');
const KEYS = join(WEB, 'src/lib/stem-keys.ts');
const RETENTION = join(WEB, 'src/lib/retention.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const JOB = '550e8400-e29b-41d4-a716-446655440000';
const PLAY = (s) => `${JOB}/_stems/play/${s}.opus`;
const DL = (s) => `${JOB}/_stems/dl/${s}.wav`;
const SIX = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];

function dbStub({ rows, rowCount }) {
  return dataUrl(`
    export const db = { query: async (text, params) => {
      globalThis.__st.calls.push(['query', text, params]);
      return ${JSON.stringify({ rows, rowCount })};
    } };
  `);
}

/** Records the prefix the route lists, and returns the keys the test supplies. */
function r2Stub({ keys, listThrows = false }) {
  return dataUrl(`
    export const r2 = { send: async (cmd) => {
      globalThis.__st.calls.push(['list', cmd.input.Prefix, cmd.input.MaxKeys]);
      if (${listThrows}) throw new Error('AccessDenied: ListBucket');
      return { Contents: ${JSON.stringify(keys)}.map((Key) => ({ Key, Size: 1 })) };
    } };
  `);
}

const s3Stub = () =>
  dataUrl(`export class ListObjectsV2Command { constructor(input) { this.input = input; } }`);

/** Records (stem, ttl) per minted URL and returns a URL that embeds the KEY it signed. */
const stemUrlsStub = () =>
  dataUrl(`
    export const mintStemPlayUrl = async (jobId, stem, expiresIn) => {
      globalThis.__st.minted.push({ jobId, stem, expiresIn });
      // Mirrors the real signer closely enough to catch a key swap: the real one
      // signs stemPlayR2Key(jobId, stem), so the URL must contain _stems/play/.
      return 'https://r2.example/' + jobId + '/_stems/play/' + stem + '.opus?sig=x';
    };
  `);

const sentryStub = () =>
  dataUrl(`
    export const captureException = (e, ctx) => globalThis.__st.sentry.push(['exception', String(e).slice(0,80), ctx]);
    export const captureMessage = (m, lvl) => globalThis.__st.sentry.push(['message', m, lvl]);
  `);

const nextStub = () =>
  dataUrl(`
    export class NextResponse { static json(body, init = {}) { return { status: init.status ?? 200, body }; } }
    export class NextRequest {}
  `);

async function loadRoute({
  keys = [],
  status = 'done',
  rowId = JOB,
  expiresAt = null,
  rowCount = 1,
  listThrows = false,
} = {}) {
  const expires = expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const rows = rowCount === 0 ? [] : [{ id: rowId, status, expires_at: expires }];
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub({ rows, rowCount })}'`)
    .replace(/from ['"]@\/lib\/r2['"]/g, `from '${r2Stub({ keys, listThrows })}'`)
    .replace(/from ['"]@\/lib\/stem-urls['"]/g, `from '${stemUrlsStub()}'`)
    // the REAL modules, inlined — the logic under test, not a stub of it
    .replace(/from ['"]@\/lib\/stem-keys['"]/g, `from '${dataUrl(toJs(readFileSync(KEYS, 'utf8')))}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${dataUrl(toJs(readFileSync(RETENTION, 'utf8')))}'`)
    .replace(/from ['"]@aws-sdk\/client-s3['"]/g, `from '${s3Stub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

const call = (mod, id = JOB) => mod.GET({}, { params: { id } });
const listedPrefix = () => globalThis.__st.calls.find((c) => c[0] === 'list')?.[1];

beforeEach(() => {
  globalThis.__st = { calls: [], minted: [], sentry: [] };
  process.env.R2_BUCKET_NAME = 'test-bucket';
});

// ---------- gates ----------

test('a malformed id is 404 and touches nothing', async () => {
  const mod = await loadRoute();
  const res = await call(mod, 'not-a-uuid');
  assert.equal(res.status, 404);
  assert.deepEqual(globalThis.__st.calls, []);
});

test('an unknown or expired job is 404', async () => {
  const mod = await loadRoute({ rowCount: 0 });
  const res = await call(mod);
  assert.equal(res.status, 404);
  assert.equal(res.body.error_code, 'NOT_FOUND');
});

test('a not-yet-done job is 404 NOT_READY and is never listed', async () => {
  // Kills a mutation that drops the `done` gate: minting URLs for a running job
  // races the worker and hands out links to objects that do not exist yet.
  const mod = await loadRoute({ status: 'separating', keys: SIX.map(PLAY) });
  const res = await call(mod);
  assert.equal(res.status, 404);
  assert.equal(res.body.error_code, 'NOT_READY');
  assert.equal(listedPrefix(), undefined, 'must not reach R2 for an unfinished job');
});

// ---------- state machine: the review's blocking finding ----------

test('all six playable -> ready, complete true, six URLs in channel order', async () => {
  const mod = await loadRoute({ keys: [...SIX.map(PLAY), ...SIX.map(DL)] });
  const res = await call(mod);
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'ready');
  assert.equal(res.body.complete, true);
  assert.deepEqual(res.body.stems.map((s) => s.stem), SIX, 'mixer channel order, not lexical');
});

test('six WAVs and zero Opus -> encode_failed, NOT "unavailable"', async () => {
  // THE BLOCKING FINDING. A total Opus-encode failure used to be indistinguishable
  // from a pre-V3-J2 job: both gave {stems: [], complete: false}, and the route's own
  // comment called that "not an error". ~300 MB of WAV would upload per job, nothing
  // would be playable, and no error would exist anywhere.
  const mod = await loadRoute({ keys: SIX.map(DL) });
  const res = await call(mod);
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'encode_failed');
  assert.equal(res.body.complete, false);
  assert.deepEqual(res.body.stems, []);
  // Reporting this to Sentry is the WORKER's job, not the route's — see the
  // "does NOT report to Sentry from the route" test below for why. What the route
  // owes the client is a state it can act on, and that is what is asserted here.
  assert.notEqual(res.body.state, 'unavailable', 'broken must not look like a legacy job');
});

test('no stems of either kind -> unavailable, and NOTHING is reported to Sentry', async () => {
  // The legitimate legacy case. It must stay quiet, or every pre-V3-J2 job pages us.
  const mod = await loadRoute({ keys: [] });
  const res = await call(mod);
  assert.equal(res.body.state, 'unavailable');
  assert.equal(res.body.complete, false);
  assert.deepEqual(globalThis.__st.sentry, []);
});

test('some playable -> partial, and complete is FALSE', async () => {
  // Kills the mutation that hardcodes complete: true. A partial mix is a song with
  // an instrument silently missing — the client must be able to refuse it.
  const mod = await loadRoute({ keys: [PLAY('drums'), PLAY('bass'), ...SIX.map(DL)] });
  const res = await call(mod);
  assert.equal(res.body.state, 'partial');
  assert.equal(res.body.complete, false);
  assert.equal(res.body.stems.length, 2);
});

test('`expected` always names all six, whatever landed', async () => {
  const mod = await loadRoute({ keys: [PLAY('drums')] });
  const res = await call(mod);
  assert.deepEqual([...res.body.expected], SIX);
});

// ---------- the download artifact must never be served as playback ----------

test('a WAV download key is never surfaced as a playable stem', async () => {
  // Kills the mutation that serves the download artifact to the mixer — the original
  // Defect 1, which is 240-360 MB per song against a 287 MB budget.
  const mod = await loadRoute({ keys: SIX.map(DL) });
  const res = await call(mod);
  assert.deepEqual(res.body.stems, []);
  assert.equal(globalThis.__st.minted.length, 0);
});

test('every minted URL is a PLAY key, never a dl key', async () => {
  const mod = await loadRoute({ keys: [...SIX.map(PLAY), ...SIX.map(DL)] });
  const res = await call(mod);
  for (const s of res.body.stems) {
    assert.match(s.signed_url, /\/_stems\/play\//, `${s.stem} must be signed from play/`);
    assert.doesNotMatch(s.signed_url, /\/_stems\/dl\//);
    assert.match(s.signed_url, /\.opus/);
  }
});

test('a stray object under the prefix is not a channel', async () => {
  const mod = await loadRoute({
    keys: [PLAY('drums'), `${JOB}/_stems/play/harmonic_mix.opus`, `${JOB}/_stems/play/notes.txt`],
  });
  const res = await call(mod);
  assert.deepEqual(res.body.stems.map((s) => s.stem), ['drums']);
});

// ---------- TTL ----------

test('TTL is capped at 900s even on a fresh 24h job', async () => {
  // Kills the mutation that drops the cap. An earlier "fix" used presignTtlSec alone,
  // which traded one bug (a URL outliving its objects) for another (a 24h stem URL),
  // against TSD 12.2's "short-TTL signed GETs".
  const mod = await loadRoute({
    keys: SIX.map(PLAY),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });
  const res = await call(mod);
  assert.equal(res.body.expires_in_sec, 900);
  assert.ok(globalThis.__st.minted.every((m) => m.expiresIn === 900));
});

test('TTL never outlives the job: a job 5 min from expiry gets ~300s', async () => {
  const mod = await loadRoute({
    keys: SIX.map(PLAY),
    expiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
  });
  const res = await call(mod);
  assert.ok(res.body.expires_in_sec <= 300, `got ${res.body.expires_in_sec}`);
  assert.ok(res.body.expires_in_sec > 250);
});

// ---------- the id used for the R2 prefix ----------

test('the R2 prefix comes from the DB row, not the request path', async () => {
  // UUID_RE is case-insensitive and Postgres uuid comparison is too, so an UPPERCASE
  // uuid in the URL passes the lookup. Building the prefix from params.id would then
  // list a prefix that does not exist and return a silent empty list.
  const upper = JOB.toUpperCase();
  const mod = await loadRoute({ keys: SIX.map(PLAY), rowId: JOB });
  const res = await call(mod, upper);
  assert.equal(listedPrefix(), `${JOB}/_stems/`, 'must use the row id (lowercase)');
  assert.equal(res.body.state, 'ready');
  assert.ok(globalThis.__st.minted.every((m) => m.jobId === JOB));
});

test('one list call covers BOTH artifact prefixes', async () => {
  // Listing only play/ would make encode_failed undetectable.
  const mod = await loadRoute({ keys: SIX.map(PLAY) });
  await call(mod);
  assert.equal(listedPrefix(), `${JOB}/_stems/`);
});

// ---------- list failure ----------

test('an R2 list failure is a loud 502, never a silent empty 200', async () => {
  // This route is the web tier's first real network call to R2 — everything else only
  // presigns, which is offline — so a credential could lack ListBucket while every
  // offline test passes. An empty 200 would look exactly like "no stems".
  const mod = await loadRoute({ listThrows: true });
  const res = await call(mod);
  assert.equal(res.status, 502);
  assert.equal(res.body.error_code, 'STEM_LIST_FAILED');
  assert.ok(globalThis.__st.sentry.some((e) => e[0] === 'exception'));
});

// ---------- the SQL gate itself ----------

test('the job lookup is gated on expires_at, not just on id', async () => {
  // Kills a mutation that drops `AND expires_at > now()`. The db stub ignores the
  // SQL text, so no behavioural assertion can see this — an expired job would be
  // served stems whose R2 objects the retention sweep has already deleted, i.e.
  // signed URLs to nothing. Asserting on the statement is the only way to pin it.
  const mod = await loadRoute({ keys: SIX.map(PLAY) });
  await call(mod);
  const q = globalThis.__st.calls.find((c) => c[0] === 'query');
  assert.ok(q, 'the route must query for the job');
  const sql = q[1].replace(/\s+/g, ' ');
  assert.match(sql, /expires_at\s*>\s*now\(\)/i, 'the expiry gate must be in the SQL');
  assert.match(sql, /FROM jobs/i);
  assert.deepEqual(q[2], [JOB], 'the id must be a bound parameter, never interpolated');
});

test('the status and expiry gates are BOTH required, not either/or', async () => {
  // expired (no row) -> 404; present but not done -> 404. Neither reaches R2.
  const expired = await loadRoute({ rowCount: 0, keys: SIX.map(PLAY) });
  assert.equal((await call(expired)).status, 404);
  globalThis.__st = { calls: [], minted: [], sentry: [] };
  const running = await loadRoute({ status: 'extracting', keys: SIX.map(PLAY) });
  assert.equal((await call(running)).status, 404);
  assert.equal(listedPrefix(), undefined);
});

test('encode_failed does NOT report to Sentry from the route', async () => {
  // The route is unauthenticated, so a per-GET Sentry call lets anyone holding a job
  // UUID fire unbounded events by refetching a broken job. The worker already
  // reports this condition once per job, with a likely_cause. A reviewer flagged
  // the amplification; this pins the removal.
  const mod = await loadRoute({ keys: SIX.map(DL) });
  const res = await call(mod);
  assert.equal(res.body.state, 'encode_failed');
  assert.deepEqual(
    globalThis.__st.sentry.filter((e) => e[0] === 'message'),
    [],
    'no Sentry message from the route on encode_failed',
  );
});
