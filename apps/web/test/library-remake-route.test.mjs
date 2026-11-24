// POST /api/library/remake and DELETE /api/library/:entryId (Phase B, B1) without a database:
// the REAL routes, the REAL lib/jobs/create-link-job.ts (B0), lib/library-server.ts,
// lib/error-copy.ts and lib/same-origin.ts; the DB, auth, admission, billing counters and trial
// are recording stubs. The money path under real concurrency is test/library-remake-pg.test.mjs.
//
// AC 5 refusals: another user's entry 404; upload 409 "Upload again"; cross-origin 403 before
// anything; ALLOW_YOUTUBE_INPUT unset 403; over quota -> the job route's 402 + existing copy;
// admission at capacity 503 + Retry-After. AC 4: a hit in findExisting (a Re-make while the
// song is queued) -> 200 with that id and NOTHING spent. Remove: owner-only, 404 otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildModuleGraph } from './helpers/module-graph.mjs';

const ME = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-0000-4000-8000-000000000001';
const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const LIVE_JOB = '33333333-0000-4000-8000-000000000003';

const S = () => globalThis.__rm;
function reset(over = {}) {
  globalThis.__rm = {
    me: ME, // whose entry it is
    user: { user_id: ME, email: 'me@example.com' },
    entry: { id: ENTRY, youtube_url: URL_, input_kind: 'youtube', title: 'Never' },
    live: null, // findExisting answer
    liveInTx: null, // beforeInsert's repeat lookup answer
    lockFound: true,
    admission: { allowed: true, error_code: null },
    quota: null,
    queries: [],
    calls: [],
    ...over,
  };
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
}

const graph = buildModuleGraph({
  name: 'library-remake-route',
  entries: ['app/api/library/remake/route.ts', 'app/api/library/[entryId]/route.ts'],
  overrides: {
    'lib/db.ts': `
      const S = () => globalThis.__rm;
      async function q(text, params, inTx) {
        const t = String(text);
        S().queries.push({ text: t, params, inTx });
        if (/FROM library_entries\\s+WHERE id = \\$1::uuid AND user_id = \\$2::uuid FOR UPDATE/.test(t))
          return { rows: S().lockFound ? [{ id: params[0] }] : [], rowCount: S().lockFound ? 1 : 0 };
        if (/^SELECT id::text AS id, youtube_url, input_kind, title FROM library_entries/.test(t.trim())) {
          const e = S().entry;
          return e && params[0] === e.id && params[1] === S().me ? { rows: [e], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/^DELETE FROM library_entries/.test(t.trim())) {
          const e = S().entry;
          const n = e && params[0] === e.id && params[1] === S().me ? 1 : 0;
          return { rows: [], rowCount: n };
        }
        if (/SELECT jobs\\.id::text AS id FROM jobs/.test(t)) {
          const id = inTx ? S().liveInTx : S().live;
          return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
        }
        if (/^INSERT INTO jobs/.test(t.trim())) { S().calls.push('INSERT jobs'); return { rows: [{ id: params[0] }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      export const db = {
        query: (t, p) => q(t, p, false),
        tx: async (fn) => { S().calls.push('BEGIN'); try { const r = await fn({ query: (t, p) => q(t, p, true) }); S().calls.push('COMMIT'); return r; }
          catch (e) { S().calls.push('ROLLBACK'); throw e; } },
      };`,
    'lib/auth/supabase.ts': 'export const getUser = async () => { globalThis.__rm.calls.push("getUser"); return globalThis.__rm.user; };',
    'lib/admission.ts': `
      export const RATE_LIMIT = 5; export const RATE_WINDOW_MS = 60000;
      export const IN_FLIGHT_STATUSES = ['queued', 'downloading', 'separating', 'extracting', 'uploading'];
      export async function checkAdmission() { globalThis.__rm.calls.push('checkAdmission'); return globalThis.__rm.admission; }`,
    'lib/client-ip.ts': 'export const clientIpHashOf = () => "iphash";',
    'lib/billing/rate-limit.ts': `
      const c = (n) => globalThis.__rm.calls.push(n);
      export async function checkBurstLimit() { c('checkBurstLimit'); return null; }
      export async function checkMonthlyQuota() { c('checkMonthlyQuota'); return globalThis.__rm.quota; }
      export async function bumpJobsUsed() { c('bumpJobsUsed'); }
      export async function bumpJobsUsedWithinQuota() { c('bumpJobsUsedWithinQuota'); return true; }
      export async function recordAllowanceDebit() { c('recordAllowanceDebit'); return true; }
      export async function rollPeriodIfStale() { c('rollPeriodIfStale'); }`,
    'lib/billing/entitlements.ts': `
      export class EntitlementError extends Error { constructor(code, message) { super(message ?? code); this.code = code; this.status = 402; } }
      export const FREE_QUOTA_EXHAUSTED_MESSAGE = 'free quota exhausted';
      export async function getEntitlementSnapshot() { return { plan_code: 'free', jobs_quota: 5, jobs_used: 0, credits_remaining: 0, services: ['youtube'] }; }
      export async function enforceEntitlement() { return { allowed: true }; }`,
    'lib/trial.ts': 'export async function consumeTrialInTx() { globalThis.__rm.calls.push("consumeTrialInTx"); return { ok: false, reason: "no_grant" }; }',
  },
  packages: {
    '@sentry/nextjs': 'export const captureException = () => {};',
    'next/server': `export class NextResponse { static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }
      export class NextRequest {}`,
  },
});
const remake = await import(graph.url('app/api/library/remake/route.ts'));
const one = await import(graph.url('app/api/library/[entryId]/route.ts'));

const HOST = 'stem-loops.com';
const req = (body, origin = `https://${HOST}`) => ({
  headers: new Headers({ origin, host: HOST, 'content-type': 'application/json' }),
  json: async () => body,
  nextUrl: new URL(`https://${HOST}/api/library/remake`),
  url: `https://${HOST}/api/library/remake`,
});
const spent = () => S().calls.filter((c) => /INSERT jobs|bump|recordAllowanceDebit|consumeTrial|checkBurstLimit|checkMonthlyQuota|checkAdmission/.test(c));

test('happy path: the entry\'s link goes through B0\'s gates and ONE song is spent (201)', async () => {
  reset();
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'queued');
  assert.deepEqual(spent(), ['checkAdmission', 'consumeTrialInTx', 'checkBurstLimit', 'checkMonthlyQuota', 'INSERT jobs', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit']);
  const ins = S().queries.find((q) => /^INSERT INTO jobs/.test(q.text.trim()));
  assert.equal(ins.params[1], URL_, 'the job is made from the ENTRY\'s link');
  assert.equal(ins.params[7], ME);
  assert.doesNotMatch(ins.text, /expires_at/, 'expires_at stays the INSERT default');
  // beforeInsert locked the caller's entry inside the tx, before the INSERT.
  const iLock = S().queries.findIndex((q) => /FOR UPDATE/.test(q.text));
  const iIns = S().queries.indexOf(ins);
  assert.ok(iLock >= 0 && iLock < iIns && S().queries[iLock].inTx, 'entry row locked FOR UPDATE in the tx before the INSERT');
  assert.deepEqual(S().queries[iLock].params, [ENTRY, ME]);
  // #372 R2 MF-2: then the per-(user, URL) link-dedupe lock a paste also takes, then the lookup.
  const iKey = S().queries.findIndex((q) => /pg_advisory_xact_lock\(hashtextextended\('link-dedupe:'/.test(q.text));
  const iLook = S().queries.findIndex((q, i) => i > iLock && q.inTx && /SELECT jobs\.id::text AS id FROM jobs/.test(q.text));
  assert.ok(iLock < iKey && iKey < iLook && iLook < iIns && S().queries[iKey].inTx, 'entry row → link-dedupe lock → lookup → INSERT');
  assert.deepEqual(S().queries[iKey].params, [ME, URL_]);
  // Re-make's lookup is still user + URL only (no stem choice: any live copy is reused).
  assert.deepEqual(S().queries[iLook].params.length, 3);
  assert.ok(!S().queries.some((q) => /(INSERT INTO|UPDATE) library_entries/.test(q.text)), 'neither hook writes the entry');
  assert.ok(!S().queries.some((q) => /expires_at/.test(q.text) && !/^SELECT/.test(q.text.trim())), 'nothing writes expires_at');
});

test('AC 4: a Re-make while the song is queued (findExisting hit) -> 200 with that id, nothing spent', async () => {
  reset({ live: LIVE_JOB });
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: LIVE_JOB });
  assert.deepEqual(spent(), []);
  const q = S().queries.find((x) => /SELECT jobs\.id::text AS id FROM jobs/.test(x.text));
  assert.deepEqual(q.params, [ME, URL_, ['queued', 'downloading', 'separating', 'extracting', 'uploading']]);
  assert.match(q.text, /jobs\.status = 'done' AND/, 'done-and-retained counts as live');
  assert.match(q.text, /OR jobs\.status = ANY\(\$3::text\[\]\)/, 'in-flight counts as live');
});

test('AC 4: a race lost in beforeInsert -> rolled back, 200 with the winner\'s id, no INSERT, no debit', async () => {
  reset({ liveInTx: LIVE_JOB });
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: LIVE_JOB });
  assert.ok(!S().calls.includes('INSERT jobs') && !S().calls.includes('recordAllowanceDebit'));
  assert.equal(S().calls.at(-1), 'ROLLBACK');
});

test('an entry Removed mid-request (lock finds no row) -> 404, rolled back, nothing spent', async () => {
  reset({ lockFound: false });
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 404);
  assert.ok(!S().calls.includes('INSERT jobs'));
});

test('AC 5: cross-origin -> 403 before auth or the database', async () => {
  reset();
  const r = await remake.POST(req({ entry_id: ENTRY }, 'https://evil.example'));
  assert.equal(r.status, 403);
  assert.deepEqual(S().calls, []);
  assert.deepEqual(S().queries, []);
});

test('signed out -> 401, nothing read', async () => {
  reset({ user: null });
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 401);
  assert.deepEqual(S().queries, []);
});

test('AC 5: another user\'s entry (or a junk id) -> 404, nothing spent; the lookup is owner-scoped', async () => {
  reset({ entry: { id: ENTRY, youtube_url: URL_, input_kind: 'youtube', title: 'x' } });
  S().user = { user_id: '99999999-9999-4999-8999-999999999999' };
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 404);
  const q = S().queries[0];
  assert.match(q.text, /WHERE id = \$1::uuid AND user_id = \$2::uuid/);
  assert.deepEqual(q.params, [ENTRY, '99999999-9999-4999-8999-999999999999']);
  assert.deepEqual(spent(), []);
  reset();
  assert.equal((await remake.POST(req({ entry_id: 'not-a-uuid' }))).status, 404);
  assert.equal((await remake.POST(req({}))).status, 404);
});

test('Q3 / AC 5: an upload entry -> 409 "Upload again", nothing spent', async () => {
  reset({ entry: { id: ENTRY, youtube_url: null, input_kind: 'upload', title: 'take' } });
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error_code, 'UPLOAD_AGAIN');
  assert.match(r.body.message, /Upload the file again/);
  assert.deepEqual(spent(), []);
});

test('AC 5: ALLOW_YOUTUBE_INPUT unset -> 403 (B0\'s gate), nothing spent', async () => {
  reset();
  delete process.env.ALLOW_YOUTUBE_INPUT;
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 403);
  assert.equal(r.body.error_code, 'DOWNLOAD_INVALID_URL');
  assert.deepEqual(spent(), []);
});

test('AC 5: admission at capacity -> 503 + Retry-After, nothing spent', async () => {
  reset({ admission: { allowed: false, error_code: 'AT_CAPACITY', message: 'busy', retry_after_s: 120 } });
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 503);
  assert.equal(r.headers['Retry-After'], '120');
  assert.deepEqual(spent(), ['checkAdmission']);
});

test('AC 5: over the monthly quota -> the job route\'s 402, with the existing quota copy', async () => {
  reset({ quota: { kind: 'quota_exceeded', resets_at: '2026-12-01T00:00:00Z' } });
  const { entitlementMessage } = await import(graph.url('lib/error-copy.ts'));
  const r = await remake.POST(req({ entry_id: ENTRY }));
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'quota_exceeded');
  assert.equal(r.body.message, entitlementMessage('FREE_MONTHLY_QUOTA_EXHAUSTED'));
  assert.ok(!S().calls.includes('INSERT jobs'));
});

test('malformed JSON -> 400', async () => {
  reset();
  const bad = { ...req({}), json: async () => { throw new SyntaxError('x'); } };
  assert.equal((await remake.POST(bad)).status, 400);
});

// ── DELETE /api/library/:entryId (Remove) ──
const del = (id, origin) => one.DELETE(req(undefined, origin), { params: { entryId: id } });

test('Remove: the owner\'s entry -> 200; the DELETE is owner-scoped', async () => {
  reset();
  const r = await del(ENTRY);
  assert.equal(r.status, 200);
  const q = S().queries.find((x) => /^DELETE FROM library_entries/.test(x.text.trim()));
  assert.match(q.text, /WHERE id = \$1::uuid AND user_id = \$2::uuid/);
  assert.deepEqual(q.params, [ENTRY, ME]);
});

test('Remove: someone else\'s entry -> 404; cross-origin -> 403 first; signed out -> 401', async () => {
  reset();
  S().user = { user_id: '99999999-9999-4999-8999-999999999999' };
  assert.equal((await del(ENTRY)).status, 404);
  reset();
  assert.equal((await del(ENTRY, 'https://evil.example')).status, 403);
  assert.deepEqual(S().queries, []);
  reset({ user: null });
  assert.equal((await del(ENTRY)).status, 401);
  reset();
  assert.equal((await del('nope')).status, 404);
});
