// Run: pnpm --filter web test
//
// GET /api/library — the signed-in user's songs from the DATABASE (Jon, 2026-11-15: paid plans
// keep songs; users build a library). What must hold:
//   * ownership is SERVER-SIDE: the only user id that reaches the query is the session's
//     (getUser()), bound as a parameter; nothing in the request can choose whose list it is;
//   * signed out -> 401 and NO query;
//   * only retained songs, by the SAME rule the job routes serve on and the worker deletes on
//     (lib/retention.ts JOB_RETAINED_UNTIL_SQL, read from the real module here), and each row's
//     expires_at IS that deadline;
//   * an allow-list of columns (no ip hash / fingerprint / R2 key), private no-store.
// The rule's real-Postgres semantics are apps/worker/tests/test_paid_retention.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';
import { buildModuleGraph } from './helpers/module-graph.mjs';

const toJs = (file) =>
  ts.transpileModule(readFileSync(join(WEB, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const retentionUrl = dataUrl(toJs('src/lib/retention.ts'));
const { JOB_RETAINED_UNTIL_SQL } = await import(retentionUrl);
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const ME = '11111111-1111-4111-8111-111111111111';
const row = (i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  title: null,
  original_filename: `song-${i}.mp3`,
  youtube_url: null,
  status: 'done',
  created_at: '2026-11-01T00:00:00.000Z',
  expires_at: '2026-12-31T00:00:00.000Z',
});

async function load({ user, rows = [], entries = [], throws = false, entriesError = null }) {
  globalThis.__lib = { queries: [] };
  // Routes by table: the jobs list gets `rows`, the library_entries list `entries` (or throws
  // `entriesError`, e.g. 42P01 before migration 043).
  const db = `
    export const db = { query: async (text, params) => {
      globalThis.__lib.queries.push({ text: String(text), params });
      if (${throws}) throw new Error('db down');
      if (/FROM library_entries/.test(String(text))) {
        const e = ${JSON.stringify(entriesError)};
        if (e) throw Object.assign(new Error(e.message), { code: e.code });
        return { rows: ${JSON.stringify(entries)}, rowCount: ${entries.length} };
      }
      return { rows: ${JSON.stringify(rows)}, rowCount: ${rows.length} };
    } };`;
  const graph = buildModuleGraph({
    name: 'library-route',
    entries: ['app/api/library/route.ts'],
    overrides: {
      'lib/db.ts': db,
      'lib/auth/supabase.ts': `export const getUser = async () => (${JSON.stringify(user)});`,
    },
    packages: {
      '@sentry/nextjs': 'export const captureException = () => {};',
      'next/server': `export class NextResponse { static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }`,
    },
  });
  return import(graph.url('app/api/library/route.ts') + '?' + Math.random());
}

const jobsQuery = () => globalThis.__lib.queries.find((q) => / FROM jobs\s+WHERE user_id/.test(q.text));
const entriesQuery = () => globalThis.__lib.queries.find((q) => /FROM library_entries/.test(q.text));

test('GET /api/library: signed out is a 401 and never queries the database', async () => {
  const { GET } = await load({ user: null });
  const res = await GET();
  assert.equal(res.status, 401);
  assert.deepEqual(res.body.songs, []);
  assert.equal(globalThis.__lib.queries.length, 0);
  assert.match(res.headers['Cache-Control'], /no-store/);
});

test('GET /api/library: owner-scoped by the SESSION user id, bound, never interpolated', async () => {
  const { GET } = await load({ user: { user_id: ME, email: 'me@example.com' }, rows: [row(1)] });
  const res = await GET();
  assert.equal(res.status, 200);
  const q = jobsQuery();
  assert.equal(q.params[0], ME, 'the only user id in the query is the session\'s');
  assert.ok(!q.text.includes(ME), 'the id is a bound parameter');
  assert.match(norm(q.text), /WHERE user_id = \$1::uuid AND /);
});

test('GET /api/library: lists only retained songs, by the shared rule, and returns its deadline', async () => {
  const { GET } = await load({ user: { user_id: ME }, rows: [row(1)] });
  await GET();
  const sql = norm(jobsQuery().text);
  const rule = norm(JOB_RETAINED_UNTIL_SQL);
  assert.ok(sql.includes(`AND ${rule} > now()`), 'the retention gate must be the shared constant');
  assert.ok(sql.includes(`${rule} AS expires_at`), 'expires_at must be the real deletion time');
  assert.match(sql, /FROM jobs WHERE/);
});

test('GET /api/library: an allow-list of columns, nothing identifying or internal', async () => {
  const { GET } = await load({ user: { user_id: ME }, rows: [row(1)] });
  await GET();
  const select = norm(jobsQuery().text).split(' FROM jobs ')[0];
  for (const banned of ['client_ip_hash', 'client_fingerprint', 'upload_r2_key', 'replicate_prediction_id', 'user_id', '*']) {
    assert.ok(!select.split(JOB_RETAINED_UNTIL_SQL.replace(/\s+/g, ' ')).join('').includes(banned), `SELECT must not read ${banned}`);
  }
});

test('GET /api/library: caps the list and says when it did', async () => {
  const many = Array.from({ length: 501 }, (_, i) => row(i));
  const { GET } = await load({ user: { user_id: ME }, rows: many });
  const res = await GET();
  assert.equal(jobsQuery().params[1], 501, 'asks for one more than it shows');
  assert.equal(res.body.songs.length, 500);
  assert.equal(res.body.truncated, true);
  const few = await load({ user: { user_id: ME }, rows: [row(1)] });
  assert.equal((await few.GET()).body.truncated, false);
});

test('GET /api/library: a database fault is a 500 with an empty list, not a crash', async () => {
  const { GET } = await load({ user: { user_id: ME }, throws: true });
  const res = await GET();
  assert.equal(res.status, 500);
  assert.deepEqual(res.body.songs, []);
});

test('/history reads the library from /api/library (the DB), not only this browser', () => {
  const src = readFileSync(join(WEB, 'src/app/history/page.tsx'), 'utf8');
  assert.match(src, /fetch\('\/api\/library'/);
  assert.match(src, /listedSongs\(/);
});

// ── demo songs (V3 Slice 0, migration 040) ──
test('GET /api/library: reads is_demo and passes it through, so /history can hide "deleted in"', async () => {
  const { DEMO_RETAINED_UNTIL } = await import(retentionUrl);
  const demo = { ...row(9), title: 'Lucky Ticket', expires_at: DEMO_RETAINED_UNTIL, is_demo: true };
  const { GET } = await load({ user: { user_id: ME }, rows: [demo, { ...row(1), is_demo: false }] });
  const res = await GET();
  // The retention SQL in the same SELECT list contains `jobs.is_demo` (its CASE), so it is
  // removed BEFORE matching; otherwise this passes with the bare column gone (review of #289,
  // MF-2: a mutant dropping `is_demo, ` from the route survived the earlier regex).
  const select = norm(jobsQuery().text).split(' FROM jobs ')[0];
  const columns = select.split(norm(JOB_RETAINED_UNTIL_SQL)).join('<RULE>');
  // The BARE column, not an expression aliased to it (re-review N-1: `NULL AS is_demo` passed
  // the looser regex, and the fake DB returns is_demo whatever is asked for). It must be its
  // own select-list item, preceded by a comma, and nothing may be aliased AS is_demo.
  assert.match(columns, /, is_demo, <RULE> AS expires_at$/, 'the SELECT list must read the is_demo column');
  assert.doesNotMatch(columns, /\bAS\s+is_demo\b/i, 'is_demo must be the column, not an aliased expression');
  assert.deepEqual(res.body.songs.map((s) => [s.is_demo, s.expires_at]), [[true, DEMO_RETAINED_UNTIL], [false, row(1).expires_at]]);
});

test('/history hides "deleted in" for a demo row (render test: history-demo-row.test.mjs)', () => {
  const src = readFileSync(join(WEB, 'src/components/library/LibraryList.tsx'), 'utf8');
  assert.match(src, /s\.isDemo \|\| s\.expiresAtMs === null \? null :/);
});

// ── Phase B, B1 (migration 043): expired songs are listed from library_entries ──
const ENTRY = {
  entry_id: '22222222-0000-4000-8000-000000000001', state: 'expired', input_kind: 'youtube',
  youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', original_filename: null, title: 'Never',
  video_id: 'dQw4w9WgXcQ', bpm: 113, musical_key: 'A major', created_at: '2026-11-01T00:00:00.000Z',
};

test('B1 AC 1: GET /api/library lists an expired entry with state "expired", title, BPM and key', async () => {
  const { GET } = await load({ user: { user_id: ME }, rows: [row(1)], entries: [ENTRY] });
  const res = await GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, [ENTRY]);
  assert.equal(res.body.songs.length, 1, 'live jobs stay in `songs` (what /loops reads)');
  const sql = norm(entriesQuery().text);
  assert.match(sql, /'expired' AS state/);
  for (const c of ['e.title', 'e.bpm', 'e.musical_key', 'e.video_id', 'e.youtube_url', 'e.original_filename']) assert.ok(sql.includes(c), c);
});

test('B1: the entries query is owner-scoped by the SESSION user id, bound', async () => {
  const { GET } = await load({ user: { user_id: ME }, entries: [ENTRY] });
  await GET();
  const q = entriesQuery();
  assert.equal(q.params[0], ME);
  assert.ok(!q.text.includes(ME));
  assert.match(norm(q.text), /WHERE e\.user_id = \$1::uuid AND /);
});

test('B1 AC 7: an entry is left out while the same user has a LIVE job of the same URL (done+retained or in flight)', async () => {
  const IN_FLIGHT_STATUSES = JSON.parse(
    readFileSync(join(WEB, 'src/lib/admission.ts'), 'utf8').match(/export const IN_FLIGHT_STATUSES = (\[[^\]]+\])/)[1].replace(/'/g, '"'),
  );
  const { GET } = await load({ user: { user_id: ME }, entries: [ENTRY] });
  await GET();
  const q = entriesQuery();
  const sql = norm(q.text);
  const rule = norm(JOB_RETAINED_UNTIL_SQL);
  assert.ok(
    sql.includes(
      `AND NOT (e.youtube_url IS NOT NULL AND EXISTS ( SELECT 1 FROM jobs WHERE jobs.user_id = $1::uuid AND jobs.youtube_url = e.youtube_url AND ((jobs.status = 'done' AND ${rule} > now()) OR jobs.status = ANY($3::text[]))))`,
    ),
    sql,
  );
  assert.deepEqual(q.params[2], IN_FLIGHT_STATUSES);
});

test('B1: before migration 043 (42P01) the library still lists the jobs, with no entries', async () => {
  const { GET } = await load({ user: { user_id: ME }, rows: [row(1)], entriesError: { code: '42P01', message: 'relation "library_entries" does not exist' } });
  const res = await GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, []);
  assert.equal(res.body.songs.length, 1);
});

test('B1: any other entries error is a 500, not a silent empty list', async () => {
  const { GET } = await load({ user: { user_id: ME }, rows: [row(1)], entriesError: { code: '42501', message: 'permission denied' } });
  assert.equal((await GET()).status, 500);
});

test('B1: signed out -> 401 with no entries and no query', async () => {
  const { GET } = await load({ user: null, entries: [ENTRY] });
  const res = await GET();
  assert.equal(res.status, 401);
  assert.deepEqual(res.body.entries, []);
  assert.equal(globalThis.__lib.queries.length, 0);
});
