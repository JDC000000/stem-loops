// POST /api/chord-edits route tests — PR-Y1.7 (TSD §1.6a).
// Harness copied from jobs-link-paid-blocked.test.mjs (stubbed deps, no DB).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/chord-edits/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

function authStub(user) {
  return dataUrl(`export const getUser = async () => (${JSON.stringify(user)});`);
}

function dbStub({
  recentCount = 0,
  insertRows = [{ id: 'edit-ok', created_at: '2026-11-04T00:00:00Z' }],
  insertRowCount = 1,
  insertThrows = null,
} = {}) {
  const payload = JSON.stringify({ recentCount, insertRows, insertRowCount });
  // Inject the throw separately so it's a real Error with a .code — passing
  // it through JSON.stringify would drop the .code.
  const throwBlock = insertThrows
    ? `const err = new Error(${JSON.stringify(insertThrows.message ?? 'db error')});
       err.code = ${JSON.stringify(insertThrows.code)};
       err.constraint = ${JSON.stringify(insertThrows.constraint ?? null)};
       throw err;`
    : '';
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    export const db = {
      query: async (text, params) => {
        globalThis.__calls.push({ fn: 'db.query', sql: text, params });
        const t = String(text);
        if (t.includes('SELECT COUNT(*)') && t.includes('chord_edits')) {
          return { rows: [{ count: cfg.recentCount }], rowCount: 1 };
        }
        if (t.includes('INSERT INTO public.chord_edits')) {
          ${throwBlock}
          return { rows: cfg.insertRows, rowCount: cfg.insertRowCount };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  `);
}

function sentryStub() {
  return dataUrl(`export const captureException = () => {};`);
}

function nextStub() {
  return dataUrl(`
    export class NextResponse {
      constructor(rawBody, init = {}) {
        this.status = (init && init.status) ?? 200;
        this.headers = new Map(Object.entries((init && init.headers) || {}));
        try { this.body = JSON.parse(rawBody); } catch { this.body = rawBody; }
      }
      static json(body, init = {}) {
        const headers = new Map(Object.entries((init && init.headers) || {}));
        return { status: init.status ?? 200, body, headers };
      }
    }
  `);
}

async function loadRoute({ user, db } = {}) {
  globalThis.__calls = [];
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user)}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(db ?? {})}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

function makeReq(body) {
  return {
    json: async () => body,
    headers: new Map(),
  };
}

const USER = { user_id: '11111111-1111-1111-1111-111111111111', email: 'u@x.co' };
const JOB_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ALPHABET = 'a'.repeat(64);

const VALID_BODY = {
  job_id: JOB_ID,
  track_hash: 't' + 'a'.repeat(63),
  start_sec: 0.0,
  end_sec: 2.0,
  original_label: 'C',
  corrected_label: 'C:min',
  provider: 'klangio',
  provider_version: 'klangio@1.0',
  alphabet_sha: ALPHABET,
};

test('401 when unauthenticated', async () => {
  const mod = await loadRoute({ user: null });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 401);
  assert.equal(res.body.error_code, 'UNAUTHENTICATED');
  // Must not touch the DB on an unauth request.
  assert.equal(globalThis.__calls.find((c) => c.fn === 'db.query'), undefined);
});

test('400 on malformed JSON body', async () => {
  const mod = await loadRoute({ user: USER });
  const bad = { json: async () => { throw new Error('bad'); }, headers: new Map() };
  const res = await mod.POST(bad);
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on missing fields', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, job_id: undefined }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on non-UUID job_id', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, job_id: 'not-a-uuid' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_HARTE on invalid Harte label', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, corrected_label: 'Cmaj7' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_HARTE');
});

test('400 CHORD_EDIT_TIME_RANGE when end_sec <= start_sec', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, start_sec: 2, end_sec: 1 }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_TIME_RANGE');
});

test('400 CHORD_EDIT_SAME_LABEL when original == corrected', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(
    makeReq({ ...VALID_BODY, original_label: 'C:min', corrected_label: 'C:min' }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_SAME_LABEL');
});

test('400 CHORD_EDIT_INVALID on unknown provider', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, provider: 'chordify' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on out-of-range confidence', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, original_confidence: 1.5 }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('429 RATE_LIMITED at 60 edits/hour', async () => {
  const mod = await loadRoute({ user: USER, db: { recentCount: 60 } });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 429);
  assert.equal(res.body.error_code, 'RATE_LIMITED');
  // Insert must NOT run when rate-limited.
  const insertCall = globalThis.__calls.find(
    (c) => c.fn === 'db.query' && String(c.sql).includes('INSERT INTO public.chord_edits'),
  );
  assert.equal(insertCall, undefined);
});

test('201 on valid submission returns edit_id + created_at', async () => {
  const mod = await loadRoute({ user: USER, db: { recentCount: 0 } });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 201);
  assert.equal(res.body.edit_id, 'edit-ok');
  assert.ok(res.body.created_at);
  // Rate-limit check ran first, then the INSERT.
  const sqls = globalThis.__calls.filter((c) => c.fn === 'db.query').map((c) => c.sql);
  assert.ok(sqls[0].includes('SELECT COUNT(*)') && sqls[0].includes('chord_edits'));
  assert.ok(sqls[1].includes('INSERT INTO public.chord_edits'));
});

test('201 includes optional fields (confidence, cqt_plan_version) in the INSERT', async () => {
  const mod = await loadRoute({ user: USER, db: { recentCount: 0 } });
  const res = await mod.POST(
    makeReq({ ...VALID_BODY, original_confidence: 0.42, cqt_plan_version: 'cqt@v2' }),
  );
  assert.equal(res.status, 201);
  const insertCall = globalThis.__calls.find(
    (c) => c.fn === 'db.query' && String(c.sql).includes('INSERT INTO public.chord_edits'),
  );
  assert.ok(insertCall);
  // Params: [user_id, job_id, track_hash, provider, provider_version,
  //         start_sec, end_sec, original_label, corrected_label,
  //         original_confidence, cqt_plan_version, alphabet_sha]
  assert.equal(insertCall.params[9], 0.42);
  assert.equal(insertCall.params[10], 'cqt@v2');
});

test('400 CHORD_EDIT_HARTE when DB returns a Harte check_violation (defensive)', async () => {
  // Server-side guard: if the Zod shape check somehow misses and the DB
  // CHECK rejects the row, surface the 400 cleanly, not a 500.
  const mod = await loadRoute({
    user: USER,
    db: {
      recentCount: 0,
      insertThrows: { code: '23514', constraint: 'chord_edits_valid_harte', message: 'bad Harte' },
    },
  });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_HARTE');
});

test('400 CHORD_EDIT_INVALID on FK violation (missing job/user)', async () => {
  const mod = await loadRoute({
    user: USER,
    db: {
      recentCount: 0,
      insertThrows: { code: '23503', constraint: 'chord_edits_job_id_fkey', message: 'fk' },
    },
  });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('500 on an unexpected DB error', async () => {
  const mod = await loadRoute({
    user: USER,
    db: { recentCount: 0, insertThrows: { code: 'XX000', message: 'kaboom' } },
  });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 500);
  assert.equal(res.body.error_code, 'INTERNAL_ERROR');
});
