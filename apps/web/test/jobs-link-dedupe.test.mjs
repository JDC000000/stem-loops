// #372: POST /api/jobs, signed-in pasted link — NO DOUBLE CHARGE. The route passes
// lib/library-server.ts pasteHooks() to createAuthedLinkJob, the same live-job lookup Re-make
// uses, with a per-(user, canonical URL) advisory lock in the insert tx.
//
// Instrument: the REAL route, the REAL create-link-job lib and the REAL library-server hooks
// (module graph), on a FAKE database that keeps a `jobs` table in memory, makes a tx's rows
// visible to others only at COMMIT, discards them at ROLLBACK, and makes the advisory lock a real
// mutex (a second tx waits for the first one's COMMIT/ROLLBACK). Gates and metering are stubs that
// log what they were asked to do. The same cases against real Postgres:
// test/jobs-link-dedupe-pg.test.mjs (CI only).
//
// Mutants this file kills (PR body maps them): no hooks · findExisting only (no beforeInsert) ·
// beforeInsert without the lock · a lookup that reuses a FAILED job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './helpers/module-graph.mjs';
import { sameOriginHeaders } from './helpers/same-origin.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const VID = 'dQw4w9WgXcQ';
const CANON = `https://www.youtube.com/watch?v=${VID}`;
const IN_FLIGHT = ['queued', 'downloading', 'separating', 'extracting', 'uploading'];

const S = () => globalThis.__dd;

// ── the fake database ──────────────────────────────────────────────────────────────────────
// Rows: { id, user_id, url, status, created }. `live` is decided from the statement's OWN
// parameters ('done' is retained here; the retention arithmetic is proven on real PG), so a
// lookup that passes 'failed' among its statuses reuses a failed job — the mutant is visible.
const DB = `
const S = () => globalThis.__dd;
let seq = 0;
const LIVE = /SELECT jobs\\.id::text AS id FROM jobs/;
const LOCK = /pg_advisory_xact_lock\\(hashtextextended\\('link-dedupe:'/;
function lookup(visible, sql, p) {
  const s = S();
  s.lookups.push({ sql, params: p });
  const statuses = p[2];
  const hit = visible
    .filter((r) => r.user_id === p[0] && r.url === p[1] && (r.status === 'done' || statuses.includes(r.status)))
    .sort((a, b) => b.created - a.created)[0];
  return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 };
}
async function outside(sql, p) {
  const s = S();
  s.log.push('db.query:' + (LIVE.test(sql) ? 'lookup' : sql.slice(0, 30)));
  if (LIVE.test(sql)) {
    const r = lookup(s.hideFromOutside ? [] : s.rows, sql, p);
    if (s.outsideBarrier) await s.outsideBarrier();
    return r;
  }
  throw new Error('unexpected outside SQL ' + sql);
}
export const db = {
  query: outside,
  tx: async (fn) => {
    const s = S();
    const tx = { pending: [], held: [] };
    s.txs += 1;
    const client = { query: async (sql, p) => {
      if (LOCK.test(sql)) {
        s.log.push('tx:lock');
        s.locks.push(p);
        const key = p.join('|');
        while (s.mutex.has(key)) await s.mutex.get(key).p;
        let release; const pr = new Promise((r) => (release = r));
        s.mutex.set(key, { p: pr, release });
        tx.held.push(key);
        return { rows: [{}], rowCount: 1 };
      }
      if (LIVE.test(sql)) { s.log.push('tx:lookup'); return lookup([...s.rows, ...tx.pending], sql, p); }
      if (/^INSERT INTO jobs/.test(sql)) {
        s.log.push('tx:insert');
        // authed link insert: [id, url, stems, bars, ipHash, window, limit, user_id]; anon: no user_id.
        tx.pending.push({ id: p[0], url: p[1], user_id: p[7] ?? null, status: 'queued', created: ++seq });
        return { rows: [{ id: p[0] }], rowCount: 1 };
      }
      throw new Error('unexpected tx SQL ' + sql);
    } };
    const end = () => { for (const k of tx.held) { const m = s.mutex.get(k); s.mutex.delete(k); m.release(); } };
    try {
      const r = await fn(client);
      s.rows.push(...tx.pending);
      s.log.push('tx:commit');
      end();
      return r;
    } catch (e) {
      s.log.push('tx:rollback');
      end();
      throw e;
    }
  },
};`;

const graph = buildModuleGraph({
  name: 'jobs-link-dedupe',
  entries: ['app/api/jobs/route.ts'],
  overrides: {
    'lib/db.ts': DB,
    'lib/admission.ts': `
      const L = (n) => globalThis.__dd.log.push(n);
      export const IN_FLIGHT_STATUSES = ${JSON.stringify(IN_FLIGHT)};
      export const RATE_LIMIT = 10, RATE_WINDOW_MS = 60000;
      export const checkAdmission = async () => { L('checkAdmission'); return { allowed: true }; };
      export const anonJobCapsWhere = () => 'TRUE', anonPresignedWhere = () => 'TRUE', presignRecordKey = () => 'k';
      export const anonJobDailyCap = () => 10, anonJobMaxInFlight = () => 2;
      export const hasAnonPresign = async () => true;
      export const lockAnonIp = async () => { L('lockAnonIp'); };
      export const checkAnonJobCaps = async () => ({ allowed: true });`,
    'lib/client-ip.ts': `export const clientIpHashOf = () => 'iphash';`,
    'lib/auth/supabase.ts': `export const getUser = async () => globalThis.__dd.user;`,
    'lib/billing/rate-limit.ts': `
      const L = (n) => globalThis.__dd.log.push(n);
      export const checkBurstLimit = async () => { L('checkBurstLimit'); return null; };
      export const checkMonthlyQuota = async () => { L('checkMonthlyQuota'); return null; };
      export const bumpJobsUsed = async () => { L('bumpJobsUsed'); };
      export const bumpJobsUsedWithinQuota = async () => { L('bumpJobsUsedWithinQuota'); return true; };
      export const recordAllowanceDebit = async (_c, _u, id) => { L('recordAllowanceDebit'); globalThis.__dd.debits.push(id); return true; };
      export const rollPeriodIfStale = async () => { L('rollPeriodIfStale'); };`,
    'lib/billing/entitlements.ts': `
      export class EntitlementError extends Error { constructor(code, m) { super(m ?? code); this.code = code; this.status = 402; } }
      export const getEntitlementSnapshot = async () => ({ plan_code: 'free', jobs_quota: 5, credits_remaining: 0 });
      export const enforceEntitlement = async () => { globalThis.__dd.log.push('enforceEntitlement'); };
      export const billingEnforced = () => false;
      export const FREE_QUOTA_EXHAUSTED_MESSAGE = 'FREE_MSG';`,
    'lib/trial.ts': `export const consumeTrialInTx = async () => {
      const s = globalThis.__dd; s.log.push('consumeTrialInTx'); return { ok: s.trial }; };`,
    'lib/billing/credits.ts': `export const consumeCreditInTx = async () => { throw new Error('credits are never spent on a link'); };`,
  },
  packages: {
    '@sentry/nextjs': 'export const captureException = (e) => { globalThis.__dd.sentry.push(e); };',
    'next/server': `export class NextResponse {
        constructor(body, init = {}) { this.status = init.status ?? 200; this.body = JSON.parse(body); }
        static json(body, init = {}) { return { status: init.status ?? 200, body }; } }
      export class NextRequest {}`,
  },
});
const route = await import(graph.url('app/api/jobs/route.ts'));

function reset(state = {}) {
  globalThis.__dd = {
    log: [], lookups: [], locks: [], debits: [], sentry: [], rows: [], mutex: new Map(), txs: 0,
    user: { user_id: USER_ID, email: 'a@b.co' }, trial: false, hideFromOutside: false, outsideBarrier: null,
    ...state,
  };
}
async function paste(url = CANON) {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  return route.POST({ headers: sameOriginHeaders(), json: async () => ({ url }) });
}
const CHARGES = ['checkAdmission', 'consumeTrialInTx', 'checkBurstLimit', 'checkMonthlyQuota', 'bumpJobsUsed',
  'bumpJobsUsedWithinQuota', 'recordAllowanceDebit', 'rollPeriodIfStale', 'enforceEntitlement'];
const charged = () => S().log.filter((n) => CHARGES.includes(n));

test('wiring: a signed-in paste looks up outside the tx, then LOCK (user, canonical URL) → lookup → INSERT inside it', async () => {
  reset();
  const r = await paste(`https://youtu.be/${VID}?si=tracking`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ['id', 'status']);
  const order = S().log.filter((n) => /^(db\.query|tx:)/.test(n));
  // The first tx is the trial attempt (no trial here: consumed:false commits, nothing written);
  // the second is the non-trial insert tx, whose FIRST statement is the link-dedupe lock.
  assert.deepEqual(order, ['db.query:lookup', 'tx:commit', 'tx:lock', 'tx:lookup', 'tx:insert', 'tx:commit']);
  assert.deepEqual(S().locks, [[USER_ID, CANON]], 'the lock key is the user and the CANONICAL url');
  for (const l of S().lookups) assert.deepEqual(l.params, [USER_ID, CANON, IN_FLIGHT]);
});

test('the lookup is the live-job predicate: done AND retained, or in flight — never failed', async () => {
  reset();
  await paste();
  const sql = S().lookups[0].sql;
  assert.match(sql, /jobs\.user_id = \$1::uuid AND jobs\.youtube_url = \$2/);
  assert.match(sql, /jobs\.status = 'done' AND \(CASE WHEN jobs\.is_demo/, 'done must also be retained (JOB_RETAINED_UNTIL_SQL)');
  assert.match(sql, /> now\(\)\) OR jobs\.status = ANY\(\$3::text\[\]\)\)/);
  assert.match(sql, /ORDER BY jobs\.created_at DESC LIMIT 1/);
  assert.ok(!S().lookups[0].params[2].includes('failed'));
});

test('(b) re-paste while queued → 200 { id } of that job, NOTHING charged, no tx at all', async () => {
  reset();
  const first = await paste();
  assert.equal(first.status, 201);
  S().log.length = 0;
  const txsBefore = S().txs;
  const again = await paste(`https://www.youtube.com/watch?v=${VID}&t=42`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { id: first.body.id });
  assert.deepEqual(charged(), [], 'findExisting answers before every gate that writes');
  assert.equal(S().txs, txsBefore);
  assert.equal(S().rows.length, 1);
  assert.equal(S().debits.length, 1);
});

test('(c) re-paste of a done (retained) job → 200 with its id, no charge', async () => {
  reset({ rows: [{ id: 'done-job', user_id: USER_ID, url: CANON, status: 'done', created: 0 }] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, { id: 'done-job' }]);
  assert.deepEqual(charged(), []);
});

test('(d) re-paste after the previous job FAILED → a new job, charged normally', async () => {
  reset({ rows: [{ id: 'failed-job', user_id: USER_ID, url: CANON, status: 'failed', created: 0 }] });
  const r = await paste();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.notEqual(r.body.id, 'failed-job');
  assert.deepEqual(charged(), ['enforceEntitlement', 'checkAdmission', 'consumeTrialInTx', 'checkBurstLimit',
    'checkMonthlyQuota', 'rollPeriodIfStale', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit']);
  assert.deepEqual(S().debits, [r.body.id]);
});

test('(e) a different URL, or the same URL by another user → a new job', async () => {
  reset({ rows: [{ id: 'q', user_id: USER_ID, url: CANON, status: 'queued', created: 0 }] });
  const other = await paste('https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.equal(other.status, 201);
  reset({ rows: [{ id: 'q', user_id: OTHER_USER, url: CANON, status: 'queued', created: 0 }] });
  const theirs = await paste();
  assert.equal(theirs.status, 201);
  assert.notEqual(theirs.body.id, 'q');
});

test('beforeInsert hit (non-trial): the tx ROLLS BACK before the INSERT — 200 with the winner, no metering', async () => {
  reset({ hideFromOutside: true, rows: [{ id: 'winner', user_id: USER_ID, url: CANON, status: 'queued', created: 0 }] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, { id: 'winner' }]);
  assert.ok(S().log.includes('tx:rollback'));
  assert.ok(!S().log.includes('tx:insert'));
  for (const n of ['bumpJobsUsed', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit', 'rollPeriodIfStale']) {
    assert.ok(!S().log.includes(n), `${n} must not run`);
  }
});

test('beforeInsert hit (trial branch): lock AFTER consumeTrialInTx, and the trial consume is rolled back', async () => {
  reset({ trial: true, hideFromOutside: true, rows: [{ id: 'winner', user_id: USER_ID, url: CANON, status: 'queued', created: 0 }] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, { id: 'winner' }]);
  const seq = S().log.filter((n) => n === 'consumeTrialInTx' || n.startsWith('tx:'));
  assert.deepEqual(seq, ['consumeTrialInTx', 'tx:lock', 'tx:lookup', 'tx:rollback'], 'lock order: trial → link-dedupe lock');
  assert.ok(!S().log.includes('checkBurstLimit'), 'a hit never falls through to burst/quota');
  assert.deepEqual(S().debits, []);
});

test('(a) two concurrent pastes of one URL (both past findExisting) → 1 job, 1 debit, both answer its id', async () => {
  let arrived = 0;
  let open;
  const gate = new Promise((r) => (open = r));
  reset({
    outsideBarrier: async () => {
      arrived += 1;
      if (arrived === 2) open();
      await Promise.race([gate, new Promise((r) => setTimeout(r, 2000))]);
    },
  });
  const results = await Promise.all([paste(), paste()]);
  assert.equal(arrived, 2, 'both requests passed findExisting before either inserted');
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201], JSON.stringify(results.map((r) => r.body)));
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal(S().rows.length, 1, 'exactly one job');
  assert.equal(S().debits.length, 1, 'exactly one debit');
  assert.equal(S().log.filter((n) => n === 'bumpJobsUsedWithinQuota').length, 1, 'one allowance unit');
});

test('anonymous paste: unchanged — no live-job lookup, no link-dedupe lock', async () => {
  reset({ user: null });
  const r = await paste();
  assert.equal(r.status, 201);
  assert.deepEqual(S().lookups, []);
  assert.deepEqual(S().locks, []);
  assert.ok(S().log.includes('lockAnonIp'));
});

test('pasteHooks is passed on the signed-in LINK branch only (upload / anonymous code untouched)', () => {
  const src = readFileSync(join(WEB, 'src/app/api/jobs/route.ts'), 'utf8');
  assert.equal(src.match(/\.\.\.pasteHooks\(\)/g)?.length, 1);
  const call = src.slice(src.indexOf('if (user) {\n      const r = await createAuthedLinkJob('));
  assert.ok(call.length < src.length && call.slice(0, 600).includes('...pasteHooks()'));
});
