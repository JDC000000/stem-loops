// POST /api/chord-edits route tests — PR-Y1.7 (TSD §1.6a) + session-6
// audit v2 F3 (ownership, validation, atomic rate-limit).
// Harness stubs deps; no real DB.

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

/**
 * The new route uses both `db.query` (for the ownership check) and
 * `db.tx` (for the rate-limit + INSERT). The stub must support both.
 *
 * `ownershipRowCount`:  controls the "SELECT 1 FROM public.jobs WHERE id=$1 AND user_id=$2"
 * `recentCount`:        rate-limit count returned inside tx
 * `insertRows`:         rows returned by the INSERT (inside tx)
 * `insertThrows`:       if set, the INSERT (inside tx) throws with this code+constraint
 */
function dbStub({
  ownershipRowCount = 1,
  recentCount = 0,
  insertRows = [{ id: 'edit-ok', created_at: '2026-11-04T00:00:00Z' }],
  insertRowCount = 1,
  insertThrows = null,
} = {}) {
  const payload = JSON.stringify({ ownershipRowCount, recentCount, insertRows, insertRowCount });
  const throwBlock = insertThrows
    ? `const err = new Error(${JSON.stringify(insertThrows.message ?? 'db error')});
       err.code = ${JSON.stringify(insertThrows.code)};
       err.constraint = ${JSON.stringify(insertThrows.constraint ?? null)};
       throw err;`
    : '';
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__calls = globalThis.__calls || [];
    async function runQuery(text, params) {
      globalThis.__calls.push({ fn: 'db.query', sql: text, params });
      const t = String(text);
      if (t.includes('FROM public.jobs') && t.includes('AND user_id')) {
        return { rows: cfg.ownershipRowCount > 0 ? [{ '?column?': 1 }] : [], rowCount: cfg.ownershipRowCount };
      }
      if (t.includes('pg_advisory_xact_lock')) {
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      }
      if (t.includes('SELECT COUNT(*)') && t.includes('chord_edits')) {
        return { rows: [{ count: cfg.recentCount }], rowCount: 1 };
      }
      if (t.includes('INSERT INTO public.chord_edits')) {
        ${throwBlock}
        return { rows: cfg.insertRows, rowCount: cfg.insertRowCount };
      }
      return { rows: [], rowCount: 0 };
    }
    export const db = {
      query: runQuery,
      tx: async (fn) => {
        globalThis.__calls.push({ fn: 'db.tx.begin' });
        try {
          const result = await fn({ query: runQuery });
          globalThis.__calls.push({ fn: 'db.tx.commit' });
          return result;
        } catch (err) {
          globalThis.__calls.push({ fn: 'db.tx.rollback' });
          throw err;
        }
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
const TRACK_HASH = 'f'.repeat(64);

const VALID_BODY = {
  job_id: JOB_ID,
  track_hash: TRACK_HASH,
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

test('400 CHORD_EDIT_INVALID on non-hex track_hash (F3 tight validation)', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, track_hash: 'g'.repeat(64) }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on track_hash length != 64 (F3)', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, track_hash: 'f'.repeat(63) }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on huge start_sec (would overflow numeric(10,3)) (F3)', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, start_sec: 1e12, end_sec: 1e12 + 1 }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on huge end_sec (F3)', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, start_sec: 0, end_sec: 1e12 }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on oversized provider_version (F3)', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, provider_version: 'x'.repeat(65) }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on oversized cqt_plan_version (F3)', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, cqt_plan_version: 'x'.repeat(65) }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('400 CHORD_EDIT_INVALID on oversized original_label (F3)', async () => {
  const mod = await loadRoute({ user: USER });
  const res = await mod.POST(makeReq({ ...VALID_BODY, original_label: 'x'.repeat(17) }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
});

test('404 CHORD_EDIT_INVALID when job_id is not owned by this user (F3)', async () => {
  const mod = await loadRoute({ user: USER, db: { ownershipRowCount: 0 } });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 404);
  assert.equal(res.body.error_code, 'CHORD_EDIT_INVALID');
  // Must have asked ownership first, then NOT reached rate-limit or INSERT.
  const sqls = globalThis.__calls.filter((c) => c.sql).map((c) => c.sql);
  assert.ok(sqls[0].includes('FROM public.jobs') && sqls[0].includes('AND user_id'));
  assert.equal(
    sqls.find((s) => s.includes('INSERT INTO public.chord_edits')),
    undefined,
  );
});

test('429 RATE_LIMITED at 60 edits/hour (atomic under tx + advisory lock)', async () => {
  const mod = await loadRoute({ user: USER, db: { recentCount: 60 } });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 429);
  assert.equal(res.body.error_code, 'RATE_LIMITED');
  // Advisory lock must have been acquired (F3: atomic path).
  const lockCall = globalThis.__calls.find(
    (c) => c.sql && String(c.sql).includes('pg_advisory_xact_lock'),
  );
  assert.ok(lockCall, 'advisory lock must run before the COUNT');
  // INSERT must NOT run.
  const insertCall = globalThis.__calls.find(
    (c) => c.sql && String(c.sql).includes('INSERT INTO public.chord_edits'),
  );
  assert.equal(insertCall, undefined);
  // The tx must have rolled back, not committed.
  assert.ok(globalThis.__calls.find((c) => c.fn === 'db.tx.rollback'));
  assert.equal(globalThis.__calls.find((c) => c.fn === 'db.tx.commit'), undefined);
});

test('201 on valid submission runs ownership check, then tx (lock+count+insert)', async () => {
  const mod = await loadRoute({ user: USER, db: { recentCount: 0 } });
  const res = await mod.POST(makeReq(VALID_BODY));
  assert.equal(res.status, 201);
  assert.equal(res.body.edit_id, 'edit-ok');
  assert.ok(res.body.created_at);
  // Order: ownership → tx.begin → advisory-lock → COUNT → INSERT → tx.commit.
  const calls = globalThis.__calls;
  const idx = (pred) => calls.findIndex(pred);
  const i_own = idx((c) => c.sql && String(c.sql).includes('FROM public.jobs'));
  const i_begin = idx((c) => c.fn === 'db.tx.begin');
  const i_lock = idx((c) => c.sql && String(c.sql).includes('pg_advisory_xact_lock'));
  const i_count = idx((c) => c.sql && String(c.sql).includes('SELECT COUNT(*)'));
  const i_insert = idx((c) => c.sql && String(c.sql).includes('INSERT INTO public.chord_edits'));
  const i_commit = idx((c) => c.fn === 'db.tx.commit');
  assert.ok(i_own >= 0 && i_begin > i_own, 'ownership check runs before tx opens');
  assert.ok(i_lock > i_begin, 'advisory lock inside tx');
  assert.ok(i_count > i_lock, 'count after lock');
  assert.ok(i_insert > i_count, 'insert after count');
  assert.ok(i_commit > i_insert, 'commit after insert');
});

test('201 includes optional fields (confidence, cqt_plan_version) in the INSERT', async () => {
  const mod = await loadRoute({ user: USER, db: { recentCount: 0 } });
  const res = await mod.POST(
    makeReq({ ...VALID_BODY, original_confidence: 0.42, cqt_plan_version: 'cqt@v2' }),
  );
  assert.equal(res.status, 201);
  const insertCall = globalThis.__calls.find(
    (c) => c.sql && String(c.sql).includes('INSERT INTO public.chord_edits'),
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
