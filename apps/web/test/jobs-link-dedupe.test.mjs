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
const LIVE = /SELECT jobs\\.id::text AS id(, jobs\\.status)? FROM jobs/;
const LOCK = /pg_advisory_xact_lock\\(hashtextextended\\('link-dedupe:'/;
const norm = (stems, dflt) => [...new Set(stems && stems.length ? stems : dflt)].sort();
function lookup(visible, sql, p) {
  const s = S();
  s.lookups.push({ sql, params: p });
  const statuses = p[2];
  // Paste lookup (#372 R2): params [user, url, statuses, normalisedStems, bars, defaultStems].
  const sameLoops = (r) => p.length < 6 ||
    ((r.bars ?? 4) === p[4] && JSON.stringify(norm(r.stems, p[5])) === JSON.stringify(p[3]));
  const skipped = p[6] ?? [];
  const hit = visible
    .filter((r) => r.user_id === p[0] && r.url === p[1] && (r.status === 'done' || statuses.includes(r.status)) && sameLoops(r)
      && !skipped.includes(r.id))
    .sort((a, b) => b.created - a.created)[0];
  return { rows: hit ? [{ id: hit.id, status: hit.status }] : [], rowCount: hit ? 1 : 0 };
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
        if (s.insertBlocked) return { rows: [], rowCount: 0 }; // the per-IP window refused it
        tx.pending.push({ id: p[0], url: p[1], stems: p[2], bars: p[3], user_id: p[7] ?? null, status: 'queued', created: ++seq });
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
    // QW-2: the R2 stem probe. __dd.broken: ids with no playable stems; __dd.probeNull: could not tell.
    'lib/jobs/stem-artifacts.ts': `export const hasPlayableStems = async (id, ipHash) => {
      const s = globalThis.__dd; s.probes.push([id, ipHash()]);
      if (s.probeNull) return null;
      return !s.broken.includes(id); };`,
    'lib/auth/supabase.ts': `export const getUser = async () => globalThis.__dd.user;`,
    'lib/billing/rate-limit.ts': `
      const L = (n) => globalThis.__dd.log.push(n);
      export const checkBurstLimit = async () => { L('checkBurstLimit'); return null; };
      export const checkMonthlyQuota = async () => { L('checkMonthlyQuota'); return globalThis.__dd.quota ?? null; };
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
    quota: null, insertBlocked: false, broken: [], probes: [], probeNull: false,
    ...state,
  };
}
async function paste(url = CANON, extra = {}) {
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  return route.POST({ headers: sameOriginHeaders(), json: async () => ({ url, ...extra }) });
}
const ALL = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
const ALL_SORTED = [...ALL].sort();
const HIT = (id) => ({ id, existing: true });
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
  for (const l of S().lookups) assert.deepEqual(l.params, [USER_ID, CANON, IN_FLIGHT, ALL_SORTED, 4, ALL, []]);
});

test('the lookup is the live-job predicate: done AND retained, or in flight — never failed', async () => {
  reset();
  await paste();
  const sql = S().lookups[0].sql;
  assert.match(sql, /jobs\.user_id = \$1::uuid AND jobs\.youtube_url = \$2/);
  assert.match(sql, /jobs\.status = 'done' AND \(CASE WHEN jobs\.is_demo/, 'done must also be retained (JOB_RETAINED_UNTIL_SQL)');
  assert.match(sql, /> now\(\)\) OR jobs\.status = ANY\(\$3::text\[\]\)\)/);
  assert.match(sql, /ORDER BY jobs\.created_at DESC LIMIT 1/);
  // R2 MF-1: the same loops — loop length and the stem SET ('{}' = the default six).
  assert.match(sql, /AND jobs\.loop_length_bars = \$5::int/);
  assert.match(sql, /THEN \$6::text\[\] ELSE jobs\.requested_stems END\) AS u\(s\)\s+ORDER BY s\) = \$4::text\[\]/);
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
  assert.deepEqual(again.body, HIT(first.body.id));
  assert.deepEqual(charged(), [], 'findExisting answers before every gate that writes');
  assert.equal(S().txs, txsBefore);
  assert.equal(S().rows.length, 1);
  assert.equal(S().debits.length, 1);
});

test('(c) re-paste of a done (retained) job → 200 with its id, no charge', async () => {
  reset({ rows: [{ id: 'done-job', user_id: USER_ID, url: CANON, status: 'done', created: 0 }] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, HIT('done-job')]);
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
  assert.deepEqual([r.status, r.body], [200, HIT('winner')]);
  assert.ok(S().log.includes('tx:rollback'));
  assert.ok(!S().log.includes('tx:insert'));
  for (const n of ['bumpJobsUsed', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit', 'rollPeriodIfStale']) {
    assert.ok(!S().log.includes(n), `${n} must not run`);
  }
});

test('beforeInsert hit (trial branch): lock AFTER consumeTrialInTx, and the trial consume is rolled back', async () => {
  reset({ trial: true, hideFromOutside: true, rows: [{ id: 'winner', user_id: USER_ID, url: CANON, status: 'queued', created: 0 }] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, HIT('winner')]);
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
  const HOOKS = '...pasteHooks({ clientIpHash: () => clientIpHashOf(request) })';
  assert.equal(src.split('...pasteHooks(').length - 1, 1);
  const call = src.slice(src.indexOf('if (user) {\n      const r = await createAuthedLinkJob('));
  assert.ok(call.length < src.length && call.slice(0, 800).includes(HOOKS));
});

// ── #372 R2 ─────────────────────────────────────────────────────────────────────────────────

test('R2 MF-1: same URL, DIFFERENT stems → a new job, charged normally', async () => {
  reset();
  const first = await paste(CANON, { stems: ['drums'] });
  assert.equal(first.status, 201);
  S().log.length = 0;
  const all = await paste(CANON);
  assert.equal(all.status, 201, JSON.stringify(all.body));
  assert.notEqual(all.body.id, first.body.id);
  assert.ok(S().log.includes('bumpJobsUsedWithinQuota') && S().log.includes('recordAllowanceDebit'));
  assert.equal(S().debits.length, 2);
  // ...and drums+bass is different from drums alone, too.
  const two = await paste(CANON, { stems: ['bass', 'drums'] });
  assert.equal(two.status, 201);
});

test('R2 MF-1: the SAME selection in another order (or all six spelt out = the default) is a hit', async () => {
  reset();
  const first = await paste(CANON, { stems: ['drums', 'bass'] });
  const again = await paste(CANON, { stems: ['bass', 'drums', 'bass'] });
  assert.deepEqual([again.status, again.body], [200, HIT(first.body.id)]);
  reset();
  const dflt = await paste(CANON);
  const spelt = await paste(CANON, { stems: [...ALL].reverse() });
  assert.deepEqual([spelt.status, spelt.body], [200, HIT(dflt.body.id)]);
  // A stored '{}' (legacy) also means all six.
  reset({ rows: [{ id: 'legacy', user_id: USER_ID, url: CANON, stems: [], bars: 4, status: 'queued', created: 0 }] });
  const legacy = await paste(CANON);
  assert.deepEqual([legacy.status, legacy.body], [200, HIT('legacy')]);
});

test('R2 MF-1: same stems, DIFFERENT loop length → a new job', async () => {
  reset();
  const four = await paste(CANON);
  const eight = await paste(CANON, { loop_length_bars: 8 });
  assert.equal(eight.status, 201);
  assert.notEqual(eight.body.id, four.body.id);
});

test('R2 SF: a hit is 200 { id, existing: true }; a new job is 201 { id, status } with no `existing`', async () => {
  reset();
  const first = await paste();
  assert.equal(first.status, 201);
  assert.equal('existing' in first.body, false);
  const again = await paste();
  assert.deepEqual([again.status, again.body], [200, HIT(first.body.id)]);
});

test('R2 SF: refusals with the REAL hooks on — 402 quota and in-tx 429 still answer, nothing written', async () => {
  reset({ quota: { resets_at: '2026-12-01T00:00:00Z' } });
  const q = await paste();
  assert.equal(q.status, 402, JSON.stringify(q.body));
  assert.equal(q.body.code, 'quota_exceeded');
  assert.deepEqual(S().rows, []);
  assert.equal(S().lookups.length, 1, 'findExisting ran (and missed) before the gate refused');

  reset({ insertBlocked: true });
  const r = await paste();
  assert.equal(r.status, 429, JSON.stringify(r.body));
  assert.equal(r.body.error_code, 'RATE_LIMITED');
  assert.deepEqual(S().rows, []);
  assert.deepEqual(S().debits, []);
  assert.ok(S().log.includes('tx:lock'), 'the 429 came from inside the hooked tx');

  // A refusal never masks a hit, and a hit never reaches the gates that refuse.
  reset({ quota: { resets_at: 'x' }, rows: [{ id: 'live', user_id: USER_ID, url: CANON, stems: ALL, bars: 4, status: 'queued', created: 0 }] });
  const hit = await paste();
  assert.deepEqual([hit.status, hit.body], [200, HIT('live')]);
  assert.ok(!S().log.includes('checkMonthlyQuota'));
});

// ── QW-2: a DONE job that cannot play (encoder failed, or its stems are gone) is not reused ──
const NEW_JOB_CHARGES = ['enforceEntitlement', 'checkAdmission', 'consumeTrialInTx', 'checkBurstLimit',
  'checkMonthlyQuota', 'rollPeriodIfStale', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit'];

test('QW-2: re-paste of a done job with NO playable stems (encode_failed / gone) → a new job, charged normally', async () => {
  reset({ broken: ['broken-job'], rows: [{ id: 'broken-job', user_id: USER_ID, url: CANON, status: 'done', created: 0 }] });
  const r = await paste();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.notEqual(r.body.id, 'broken-job');
  assert.equal(r.body.existing, undefined);
  assert.deepEqual(charged(), NEW_JOB_CHARGES);
  assert.deepEqual(S().debits, [r.body.id]);
  // Probed ONCE (findExisting); beforeInsert's repeat reused the verdict and skipped it again.
  assert.deepEqual(S().probes, [['broken-job', 'iphash']]);
  const inTx = S().lookups.at(-1).params;
  assert.deepEqual(inTx[6], ['broken-job'], 'the in-tx lookup excludes the unplayable job');
  // And the NEXT re-paste reuses that new (queued) job: one broken job costs one new song, not a loop.
  S().log.length = 0;
  const again = await paste();
  assert.deepEqual([again.status, again.body], [200, HIT(r.body.id)]);
  assert.deepEqual(charged(), []);
});

test('QW-2: a done job that CAN play is still reused (probe true), and an in-flight one is never probed', async () => {
  reset({ rows: [{ id: 'good-done', user_id: USER_ID, url: CANON, status: 'done', created: 0 }] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, HIT('good-done')]);
  assert.deepEqual(charged(), []);
  assert.deepEqual(S().probes.map((p) => p[0]), ['good-done']);

  reset({ broken: ['q'], rows: [{ id: 'q', user_id: USER_ID, url: CANON, status: 'queued', created: 0 }] });
  const q = await paste();
  assert.deepEqual([q.status, q.body], [200, HIT('q')]);
  assert.deepEqual(S().probes, [], 'an in-flight hit has no stems yet and is reused without a probe');
});

test('QW-2: probe could not tell (rate limit / R2 fault → null) → reuse, never a second charged job', async () => {
  reset({ probeNull: true, broken: ['d'], rows: [{ id: 'd', user_id: USER_ID, url: CANON, status: 'done', created: 0 }] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, HIT('d')]);
  assert.deepEqual(charged(), []);
});

test('QW-2: a newer broken done job is skipped for an OLDER playable one of the same selection', async () => {
  reset({ broken: ['newer'], rows: [
    { id: 'older', user_id: USER_ID, url: CANON, status: 'done', created: 1 },
    { id: 'newer', user_id: USER_ID, url: CANON, status: 'done', created: 2 },
  ] });
  const r = await paste();
  assert.deepEqual([r.status, r.body], [200, HIT('older')]);
  assert.deepEqual(charged(), []);
  assert.deepEqual(S().lookups.map((l) => l.params[6]), [[], ['newer']]);
});

test('QW-2: at most PASTE_MAX_SKIPPED (3) broken jobs are probed per lookup, then a new job', async () => {
  const ids = ['b1', 'b2', 'b3', 'b4'];
  reset({ broken: ids, rows: ids.map((id, i) => ({ id, user_id: USER_ID, url: CANON, status: 'done', created: i })) });
  const r = await paste();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(S().probes.map((p) => p[0]), ['b4', 'b3', 'b2']);
  assert.deepEqual(charged(), NEW_JOB_CHARGES);
});
