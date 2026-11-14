// Input trim (Jon, 2026-11-14): "If a song is more than 5 minutes, it should still be converted
// to a play along, but it just [processes the first] 5 minutes of the song."
//
// The worker records the trim on the downloading/completed job event as
//   detail = {"trimmed": true, "source_sec": X, "used_sec": N}
// and GET /api/jobs/:id exposes it as input_trim_used_sec / input_trim_source_sec. This file
// covers (1) the pure helper that reads and words it, and (2) the REAL route handler over a
// fake db, including that `detail` — which carries `cost_usd` on the separating event — never
// reaches the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';
import { INPUT_TRIM_URL, INPUT_TRIM_IMPORT_RE } from './helpers/input-trim.mjs';
import { inputTrimFromEvents, trimNote, jobTrimNote } from '../src/lib/input-trim.ts';

// ───────────────────────────── the pure helper ─────────────────────────────

const ev = (stage, phase, detail = null) => ({ stage, phase, detail });

test('inputTrimFromEvents reads the downloading/completed detail the worker writes', () => {
  const events = [
    ev('downloading', 'started'),
    ev('downloading', 'completed', { trimmed: true, source_sec: 372.4, used_sec: 300.0 }),
    ev('separating', 'started'),
    ev('separating', 'completed', { cost_usd: 0.42 }),
  ];
  assert.deepEqual(inputTrimFromEvents(events), { usedSec: 300, sourceSec: 372.4 });
});

test('an unknown original length is carried as null, not guessed', () => {
  const events = [ev('downloading', 'completed', { trimmed: true, source_sec: null, used_sec: 300 })];
  assert.deepEqual(inputTrimFromEvents(events), { usedSec: 300, sourceSec: null });
});

test('anything but the exact worker shape is "not trimmed"', () => {
  for (const detail of [
    null,
    {},
    { cost_usd: 0.4 },
    { trimmed: false, source_sec: 400, used_sec: 300 },
    { trimmed: 'true', source_sec: 400, used_sec: 300 },
    { trimmed: true, source_sec: 400 },
    { trimmed: true, source_sec: 400, used_sec: 0 },
    { trimmed: true, source_sec: 400, used_sec: 'x' },
  ]) {
    assert.equal(inputTrimFromEvents([ev('downloading', 'completed', detail)]), null, JSON.stringify(detail));
  }
  // …and a trimmed-looking detail on some OTHER event is ignored.
  assert.equal(
    inputTrimFromEvents([ev('separating', 'completed', { trimmed: true, source_sec: 400, used_sec: 300 })]),
    null,
  );
  assert.equal(inputTrimFromEvents([]), null);
});

test('the LAST downloading/completed wins (a reaper rerun emits a fresh one)', () => {
  const events = [
    ev('downloading', 'completed', { trimmed: true, source_sec: 400, used_sec: 300 }),
    ev('downloading', 'completed', null),
  ];
  assert.equal(inputTrimFromEvents(events), null);
});

test('trimNote words it as m:ss, the way the brief asked', () => {
  assert.equal(trimNote(300, 372), 'Using the first 5:00 of a 6:12 track.');
  assert.equal(trimNote(299.98, 612), 'Using the first 5:00 of a 10:12 track.'); // a cut can read a hair short
  assert.equal(trimNote(300, 3600), 'Using the first 5:00 of a 60:00 track.');
  assert.equal(trimNote(300, null), 'Using the first 5:00 of this track.');
  // The source rounds UP, so a 300.4 s original never reads "the first 5:00 of a 5:00 track".
  assert.equal(trimNote(300, 300.4), 'Using the first 5:00 of a 5:01 track.');
  // A source that is somehow not longer than what was used is not named at all.
  assert.equal(trimNote(300, 120), 'Using the first 5:00 of this track.');
});

test('jobTrimNote is null for an untouched job and worded for a trimmed one', () => {
  assert.equal(jobTrimNote({}), null);
  assert.equal(jobTrimNote({ input_trim_used_sec: null, input_trim_source_sec: null }), null);
  assert.equal(jobTrimNote({ input_trim_used_sec: 300, input_trim_source_sec: 372 }), 'Using the first 5:00 of a 6:12 track.');
  assert.equal(jobTrimNote({ input_trim_used_sec: 300, input_trim_source_sec: null }), 'Using the first 5:00 of this track.');
});

// ─────────────────────── the REAL route over a fake db ───────────────────────

const JOB = '550e8400-e29b-41d4-a716-446655440000';
const toJs = (file) =>
  ts.transpileModule(readFileSync(join(WEB, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const dbStub = dataUrl(`
  export const db = { query: async (text, params) => {
    const t = String(text);
    if (/FROM jobs/.test(t)) {
      if (params[0] !== '${JOB}') return { rows: [], rowCount: 0 };
      return { rows: [{ user_id: null, id: '${JOB}', status: 'done',
        expires_at: new Date(Date.now() + 3600e3).toISOString() }], rowCount: 1 };
    }
    if (/FROM job_events/.test(t)) {
      // Postgres returns only the columns the SELECT names: model that, so a route that
      // stopped selecting detail would see no trim rather than a fake one.
      const wantsDetail = /\\bdetail\\b/.test(/SELECT([\\s\\S]*?)FROM job_events/.exec(t)[1]);
      const rows = globalThis.__trimEvents.map((e) => {
        const r = { ...e };
        if (!wantsDetail) delete r.detail;
        return r;
      });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  } };
`);

async function loadRoute() {
  const js = toJs('src/app/api/jobs/[id]/route.ts')
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/job-access['"]/g, `from '${dataUrl('export const mayReadJob = async () => true;')}'`)
    .replace(INPUT_TRIM_IMPORT_RE, `from '${INPUT_TRIM_URL}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${dataUrl('export const presignTtlSec = () => 900;')}'`)
    .replace(/from ['"]@\/lib\/r2['"]/g, `from '${dataUrl("export const mintSignedUrl = async (k) => 'https://signed/' + k;")}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${dataUrl('export const captureException = () => {};')}'`)
    .replace(
      /from ['"]next\/server['"]/g,
      `from '${dataUrl(`
        export class NextRequest {}
        export class NextResponse {
          static json(body, init = {}) { return { status: init.status ?? 200, body }; }
        }
      `)}'`,
    );
  return import(dataUrl(js) + '#' + Math.random());
}

const get = async () => (await loadRoute()).GET({ headers: { get: () => null } }, { params: { id: JOB } });

const EVENTS_TRIMMED = [
  { id: 1, job_id: JOB, stage: 'downloading', phase: 'started', pct: 0, duration_ms: null, detail: null, created_at: 't1' },
  { id: 2, job_id: JOB, stage: 'downloading', phase: 'completed', pct: 100, duration_ms: null,
    detail: { trimmed: true, source_sec: 372.4, used_sec: 300.0 }, created_at: 't2' },
  { id: 3, job_id: JOB, stage: 'separating', phase: 'completed', pct: 100, duration_ms: null,
    detail: { cost_usd: 0.4242 }, created_at: 't3' },
];

test('GET /api/jobs/:id exposes the trim from the downloading/completed event', async () => {
  globalThis.__trimEvents = EVENTS_TRIMMED;
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.body.input_trim_used_sec, 300);
  assert.equal(res.body.input_trim_source_sec, 372.4);
  assert.equal(res.body.events.length, 3, 'events are still all returned');
});

test('GET /api/jobs/:id never sends job_events.detail (it carries cost_usd) to the browser', async () => {
  globalThis.__trimEvents = EVENTS_TRIMMED;
  const res = await get();
  for (const e of res.body.events) assert.equal('detail' in e, false, `event ${e.id} leaked its detail`);
  assert.equal(JSON.stringify(res.body).includes('cost_usd'), false);
  assert.equal(JSON.stringify(res.body).includes('0.4242'), false);
});

test('GET /api/jobs/:id: an untouched job carries explicit nulls', async () => {
  globalThis.__trimEvents = EVENTS_TRIMMED.map((e) => (e.id === 2 ? { ...e, detail: null } : e));
  const res = await get();
  assert.equal(res.body.input_trim_used_sec, null);
  assert.equal(res.body.input_trim_source_sec, null);
});
