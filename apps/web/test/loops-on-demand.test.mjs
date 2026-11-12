/**
 * Migration 033 — on-demand loop cutting, web side.
 *
 * Three things are gated here, and the first is the one this change lives or
 * dies on:
 *
 *   1. THE PLAY-ALONG PLAYER STILL WORKS ON UNCUT ROWS. The pipeline now records
 *      loops without cutting them, so every row a freshly finished job has is
 *      uncut. `lib/play/sections.ts` must derive the same section regions from
 *      those rows that it derived before. Asserted by running the REAL
 *      `deriveSections` over rows that differ from the pre-033 ones in exactly
 *      the ways the split makes them differ (cut_at null, waveform_peaks null,
 *      signed_url null) and comparing to the regions from fully cut rows.
 *   2. GET /api/jobs/:id withholds a signed URL for an uncut row, and only for
 *      an uncut row. A URL to an object that does not exist is a 404 the client
 *      cannot tell from an expired job.
 *   3. POST /api/jobs/:id/loops is ownership-checked, and the button that calls
 *      it is CLICKED, not merely rendered. `renderToStaticMarkup` renders the
 *      initial state and never runs a handler, so a gate built on it would stay
 *      green on a component that requested nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// ───────────── 1. the player's sections survive the split ─────────────

const SECTIONS_SRC = join(WEB, 'src/lib/play/sections.ts');

async function loadSections() {
  return await import(dataUrl(toJs(readFileSync(SECTIONS_SRC, 'utf8'))) + '#' + Math.random());
}

/** Six stems x three musical sections, the shape a real 6-stem job produces. */
function rowsFor({ cut }) {
  const stems = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
  const spans = [
    { section_label: 'intro', start_sec: '0.000', end_sec: '8.000' },
    { section_label: 'verse', start_sec: '8.000', end_sec: '24.000' },
    { section_label: 'chorus', start_sec: '24.000', end_sec: '40.000' },
  ];
  return stems.flatMap((stem, i) =>
    spans.map((s, j) => ({
      id: `${stem}-${j}`,
      stem,
      ...s,
      bar_count: 4,
      // The ONLY columns the split changes.
      r2_key: `job/${stem}/4bar_${s.section_label}_000${j}.wav`,
      cut_at: cut ? '2026-11-11T00:00:00.000Z' : null,
      waveform_peaks: cut ? [0.1, 0.2] : null,
      signed_url: cut ? `https://r2.example/${stem}-${i}-${j}` : null,
    })),
  );
}

test('deriveSections produces IDENTICAL regions for uncut and cut rows', async () => {
  const { deriveSections } = await loadSections();
  const fromUncut = deriveSections(rowsFor({ cut: false }), { durationSec: 40 });
  const fromCut = deriveSections(rowsFor({ cut: true }), { durationSec: 40 });

  // Hand-written, not recomputed with deriveSections: six stems collapse to the
  // three musical sections, in order, non-overlapping.
  assert.deepEqual(fromUncut, [
    { startSec: 0, endSec: 8, label: 'intro' },
    { startSec: 8, endSec: 24, label: 'verse' },
    { startSec: 24, endSec: 40, label: 'chorus' },
  ]);
  // And the split changed nothing: this is the acceptance criterion.
  assert.deepEqual(fromUncut, fromCut);
});

test('sections.ts reads NONE of the columns the on-demand split defers', async () => {
  // The structural reason (1) holds, asserted against the module's own source
  // rather than inferred from one passing case. If a future edit made the player
  // read r2_key or waveform_peaks, the eager cut would become load-bearing again
  // and this gate is where that shows up.
  const src = readFileSync(SECTIONS_SRC, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const column of ['r2_key', 'waveform_peaks', 'signed_url', 'duration_ms', 'cut_at']) {
    assert.equal(
      src.includes(column),
      false,
      `sections.ts must not read ${column} — the on-demand split leaves it null`,
    );
  }
  // ...and it DOES read the three that record_loops writes. Imported and used,
  // not grepped: a comment naming them would satisfy a regex.
  const { deriveSections } = await loadSections();
  assert.deepEqual(
    deriveSections([{ section_label: 'verse', start_sec: 1, end_sec: 5 }]),
    [{ startSec: 1, endSec: 5, label: 'verse' }],
  );
  assert.deepEqual(deriveSections([{ section_label: 'verse', start_sec: 1 }]), []);
  assert.deepEqual(deriveSections([{ start_sec: 1, end_sec: 5 }]), []);
});

// ───────────── 2. GET /api/jobs/:id and the signed URL ─────────────

const JOB_ROUTE = join(WEB, 'src/app/api/jobs/[id]/route.ts');

/**
 * The loops mock EXECUTES the query's WHERE clause instead of ignoring it.
 *
 * It used to return the configured rows for any text containing 'FROM loops',
 * so it could not tell a filtering route from a non-filtering one. Adding
 * `AND cut_at IS NOT NULL` to the route's loops SELECT therefore left the whole
 * web suite byte-identically green (1266/1246/0/20) while the play-along player
 * lost every section region: a fresh job's rows are ALL uncut, so the filter
 * returns nothing and `deriveSections` gets an empty array.
 *
 * Why this is read off the WHERE clause and not the whole statement: `cut_at` is
 * a legitimate member of the SELECT list — the route needs the column in order
 * to decide about signed URLs — so "the query mentions cut_at" is true of the
 * CORRECT route and cannot be the signal. Only the text after the first WHERE is
 * considered.
 *
 * And why this is not the fragment-assertion trap in another costume: nothing
 * here asserts on SQL text. This function only decides what a fake database
 * hands back; the gates below then assert on the rows the route returns and on
 * the regions the real `deriveSections` derives from them. A comment or a
 * rephrasing cannot satisfy that, because only an actually-unfiltered row set
 * produces the regions. The default is also loud, not permissive: a `cut_at`
 * predicate shape this mock does not model THROWS, so an unmodelled filter is a
 * red test rather than a silent pass.
 */
export function loopsMatching(sql, rows) {
  const m = /\bWHERE\b([\s\S]*)$/i.exec(String(sql));
  const where = (m ? m[1] : '').replace(/\s+/g, ' ');
  if (!/cut_at/i.test(where)) return rows;
  const isCut = (r) => r.cut_at !== null && r.cut_at !== undefined;
  if (/cut_at IS NOT NULL/i.test(where)) return rows.filter(isCut);
  if (/cut_at IS NULL/i.test(where)) return rows.filter((r) => !isCut(r));
  throw new Error(`the loops mock cannot honour this cut_at predicate: ${where.trim()}`);
}
// Reached from inside the generated mock module, which cannot see this scope.
// Kept out of the generated source on purpose: a regex written inside a template
// literal has its `\s` and `\b` eaten as string escapes before it is ever a
// regex, which is its own silent-failure story.
globalThis.__loopsMatching = loopsMatching;

async function loadJobRoute(loops) {
  globalThis.__minted = [];
  let js = toJs(readFileSync(JOB_ROUTE, 'utf8'));
  js = js
    .replace(
      /from ['"]@\/lib\/db['"]/g,
      `from '${dataUrl(`
        const loops = ${JSON.stringify(loops)};
        export const db = { query: async (text) => {
          const t = String(text);
          if (t.includes('FROM jobs')) return { rows: [{ id: 'j', expires_at: '2099-01-01T00:00:00Z', bpm: 120, musical_key: 'C major' }], rowCount: 1 };
          if (t.includes('FROM job_events')) return { rows: [], rowCount: 0 };
          if (t.includes('FROM loops')) {
            const rows = globalThis.__loopsMatching(t, loops);
            return { rows, rowCount: rows.length };
          }
          return { rows: [], rowCount: 0 };
        } };
      `)}'`,
    )
    .replace(
      /from ['"]@\/lib\/r2['"]/g,
      `from '${dataUrl(`
        export const mintSignedUrl = async (key) => { globalThis.__minted.push(key); return 'https://signed/' + key; };
      `)}'`,
    )
    .replace(
      /from ['"]@\/lib\/retention['"]/g,
      `from '${dataUrl(`export const presignTtlSec = () => 900;`)}'`,
    )
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${dataUrl(`export const captureException = () => {};`)}'`)
    .replace(
      /from ['"]next\/server['"]/g,
      `from '${dataUrl(`
        export class NextRequest {}
        export const NextResponse = { json: (body, init = {}) => ({ status: (init && init.status) ?? 200, body }) };
      `)}'`,
    );
  return await import(dataUrl(js) + '#' + Math.random());
}

const loopRow = (id, cut) => ({
  id,
  r2_key: `key-${id}`,
  filename: `${id}.wav`,
  section_label: 'verse',
  start_sec: '0',
  end_sec: '8',
  cut_at: cut ? '2026-11-11T00:00:00.000Z' : null,
});

test('GET /api/jobs/:id mints a signed URL for cut rows and NOT for uncut ones', async () => {
  const { GET } = await loadJobRoute([loopRow('a', true), loopRow('b', false), loopRow('c', true)]);
  const res = await GET({}, { params: { id: '11111111-1111-4111-8111-111111111111' } });

  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.loops.map((l) => [l.id, l.signed_url]));
  assert.equal(byId.a, 'https://signed/key-a');
  assert.equal(byId.c, 'https://signed/key-c');
  assert.equal(byId.b, null, 'an uncut row must not carry a signed URL');
  // The real guarantee: the signer was never even CALLED for the uncut row, so
  // no R2 work and no 404-able URL is produced. Asserting only on the response
  // would pass a route that signed and then discarded.
  assert.deepEqual(globalThis.__minted.sort(), ['key-a', 'key-c']);
});

test('GET /api/jobs/:id still returns every row, cut or not — the player needs them all', async () => {
  // This bites now that the db mock executes the WHERE clause (`loopsMatching`
  // above). Before that it could not: the mock returned both rows whatever the
  // route asked for, so a route that filtered on `cut_at` passed here.
  const { GET } = await loadJobRoute([loopRow('a', false), loopRow('b', false)]);
  const res = await GET({}, { params: { id: '11111111-1111-4111-8111-111111111111' } });
  assert.equal(res.body.loops.length, 2, 'uncut rows must not be filtered out of the response');
  assert.deepEqual(globalThis.__minted, []);
});

test('the rows GET /api/jobs/:id hands back still yield EVERY section region', async () => {
  // The guarantee at the level where the row set is actually chosen. It is well
  // defended one level down — a mutant inside `sections.ts` is killed by 34
  // tests — and the route's SELECT is what decides which rows `deriveSections`
  // ever sees, so a filter there loses the player's regions without any gate in
  // `sections.ts` noticing.
  //
  // 18 rows, 6 stems x 3 sections, EVERY ONE UNCUT: exactly what a freshly
  // finished job has after 033, when nobody has asked for the loops yet.
  const fresh = rowsFor({ cut: false });
  const { GET } = await loadJobRoute(fresh);
  const res = await GET({}, { params: { id: '11111111-1111-4111-8111-111111111111' } });

  assert.equal(res.status, 200);

  // The REAL deriveSections over the REAL response, not a restatement of the
  // route's SQL. Expectations are hand-written, not recomputed. Asserted FIRST
  // so that a route which drops rows fails as the user-visible loss it is —
  // sections missing from the player — rather than as a row-count mismatch.
  const { deriveSections } = await loadSections();
  assert.deepEqual(
    deriveSections(res.body.loops, { durationSec: 40 }),
    [
      { startSec: 0, endSec: 8, label: 'intro' },
      { startSec: 8, endSec: 24, label: 'verse' },
      { startSec: 24, endSec: 40, label: 'chorus' },
    ],
    'the play-along player lost section regions: GET /api/jobs/:id is not handing back every loop row',
  );
  assert.equal(res.body.loops.length, 18, 'the player must receive all 18 uncut rows');
  // Nothing was signed, so the regions came from genuinely uncut rows.
  assert.deepEqual(globalThis.__minted, []);
});

// ───────────── 3. POST/GET /api/jobs/:id/loops ─────────────

const LOOPS_ROUTE = join(WEB, 'src/app/api/jobs/[id]/loops/route.ts');

async function loadLoopsRoute({ job, user = null, uncut = 3, insertThrows = null, live = null } = {}) {
  globalThis.__sql = [];
  const cfg = JSON.stringify({ job, uncut, insertThrows, live });
  let js = toJs(readFileSync(LOOPS_ROUTE, 'utf8'));
  js = js
    .replace(
      /from ['"]@\/lib\/db['"]/g,
      `from '${dataUrl(`
        const cfg = ${cfg};
        export const db = { query: async (text, params) => {
          const t = String(text);
          globalThis.__sql.push({ t, params });
          if (t.includes('FROM jobs')) {
            return cfg.job ? { rows: [cfg.job], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          if (t.includes('cut_at IS NULL')) return { rows: [{ count: cfg.uncut }], rowCount: 1 };
          if (t.includes('INSERT INTO loop_requests')) {
            if (cfg.insertThrows) { const e = new Error('dup'); e.code = cfg.insertThrows; throw e; }
            return { rows: [{ id: 'req-1', status: 'queued', created_at: 'now' }], rowCount: 1 };
          }
          if (t.includes('FROM loop_requests')) {
            return { rows: cfg.live ? [cfg.live] : [], rowCount: cfg.live ? 1 : 0 };
          }
          if (t.includes('COUNT(cut_at)')) return { rows: [{ total: 10, cut: 4 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        } };
      `)}'`,
    )
    .replace(
      /from ['"]@\/lib\/auth\/supabase['"]/g,
      `from '${dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`)}'`,
    )
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${dataUrl(`export const captureException = () => {};`)}'`)
    .replace(
      /from ['"]next\/server['"]/g,
      `from '${dataUrl(`
        export class NextRequest {}
        export const NextResponse = { json: (body, init = {}) => ({ status: (init && init.status) ?? 200, body }) };
      `)}'`,
    );
  return await import(dataUrl(js) + '#' + Math.random());
}

const OK_ID = '22222222-2222-4222-8222-222222222222';
const doneJob = (user_id = null) => ({ user_id, status: 'done' });

test('POST queues a request for an anonymous job and reports what is pending', async () => {
  const { POST } = await loadLoopsRoute({ user: null, job: doneJob(null), uncut: 60 });
  const res = await POST({}, { params: { id: OK_ID } });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'queued');
  assert.equal(res.body.loops_pending, 60);
  assert.equal(res.body.request.id, 'req-1');
  assert.ok(globalThis.__sql.some((c) => c.t.includes('INSERT INTO loop_requests')));
});

test('POST on another user\'s job is a 404 and writes NOTHING', async () => {
  const { POST } = await loadLoopsRoute({ user: { user_id: 'someone-else' }, job: doneJob('the-owner'), uncut: 60 });
  const res = await POST({}, { params: { id: OK_ID } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error_code, 'NOT_FOUND');
  // 404 not 403: a 403 would confirm the job exists.
  assert.equal(
    globalThis.__sql.some((c) => c.t.includes('INSERT INTO loop_requests')),
    false,
    'a rejected caller must not reach the INSERT',
  );
});

test('POST on your OWN job is allowed and records you as the requester', async () => {
  const { POST } = await loadLoopsRoute({ user: { user_id: 'the-owner' }, job: doneJob('the-owner'), uncut: 12 });
  const res = await POST({}, { params: { id: OK_ID } });
  assert.equal(res.status, 202);
  const insert = globalThis.__sql.find((c) => c.t.includes('INSERT INTO loop_requests'));
  assert.deepEqual(insert.params, [OK_ID, 'the-owner']);
});

test('POST while a cut is already live returns the live request, not a duplicate', async () => {
  // 23505 is the partial unique index refusing a second live row. The route must
  // translate it, because the DB — not the route — is what enforces one live
  // request per job.
  const { POST } = await loadLoopsRoute({ user: null,
    job: doneJob(null),
    uncut: 60,
    insertThrows: '23505',
    live: { id: 'req-live', status: 'running', created_at: 'then' },
  });
  const res = await POST({}, { params: { id: OK_ID } });
  assert.equal(res.status, 200);
  assert.equal(res.body.already_requested, true);
  assert.equal(res.body.request.id, 'req-live');
  assert.equal(res.body.status, 'running');
});

test('POST rethrows a non-unique DB error as a 500 rather than swallowing it', async () => {
  const { POST } = await loadLoopsRoute({ user: null, job: doneJob(null), uncut: 60, insertThrows: '23503' });
  const res = await POST({}, { params: { id: OK_ID } });
  assert.equal(res.status, 500);
  assert.equal(res.body.error_code, 'INTERNAL_ERROR');
});

test('POST on a job that is still processing is a 409, not a queued request', async () => {
  const { POST } = await loadLoopsRoute({ user: null, job: { user_id: null, status: 'separating' }, uncut: 0 });
  const res = await POST({}, { params: { id: OK_ID } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error_code, 'LOOPS_NOT_READY');
});

test('POST when everything is already cut is an idempotent success', async () => {
  const { POST } = await loadLoopsRoute({ user: null, job: doneJob(null), uncut: 0 });
  const res = await POST({}, { params: { id: OK_ID } });
  assert.equal(res.status, 200);
  assert.equal(res.body.loops_pending, 0);
  assert.equal(res.body.request, null);
  assert.equal(
    globalThis.__sql.some((c) => c.t.includes('INSERT INTO loop_requests')),
    false,
  );
});

test('POST with a shape-invalid id is a 404 and never touches the database', async () => {
  const { POST } = await loadLoopsRoute({ user: null, job: doneJob(null) });
  const res = await POST({}, { params: { id: 'not-a-uuid' } });
  assert.equal(res.status, 404);
  assert.deepEqual(globalThis.__sql, []);
});

test('GET reports cut/pending counts and the latest request', async () => {
  const { GET } = await loadLoopsRoute({ user: null,
    job: doneJob(null),
    live: { id: 'req-9', status: 'done', loops_cut: 4, error_code: null },
  });
  const res = await GET({}, { params: { id: OK_ID } });
  assert.equal(res.status, 200);
  assert.equal(res.body.loops_total, 10);
  assert.equal(res.body.loops_cut, 4);
  assert.equal(res.body.loops_pending, 6);
  assert.equal(res.body.request.id, 'req-9');
});

test('GET on another user\'s job is a 404', async () => {
  const { GET } = await loadLoopsRoute({ user: { user_id: 'someone-else' }, job: doneJob('the-owner') });
  const res = await GET({}, { params: { id: OK_ID } });
  assert.equal(res.status, 404);
});
