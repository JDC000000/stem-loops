// Phase B B0: src/lib/jobs/create-link-job.ts — the authed link-job path of POST /api/jobs,
// extracted with no behaviour change, plus the findExisting / beforeInsert hook contract
// (PHASE-B-BRIEF r4.2, D-e).
//
// Instrument: the REAL module (transpiled in memory; it has no runtime imports) run against a
// stateful fake world. The fake holds the rows the money path writes — jobs,
// entitlements.jobs_used, trial_grants.songs_used, job_allowance_debits and burst rows — and
// its db.tx is a real transaction model: it serialises transactions (standing in for the
// row/advisory locks the hook takes), snapshots the rows at BEGIN and restores them on a throw.
// Every dependency call is appended to `log`, so the ORDER of the gates is asserted exactly.
//
// What this file does NOT prove (and where it is proved): the SQL of each dependency, and the
// route's wiring of the lib into POST /api/jobs (the existing /api/jobs contract tests:
// jobs-trial-channel, jobs-link-paid-allowed, entitlement-refusal-no-leak,
// billing-free-upload-quota, admission-at-capacity, jobs-upload-single-debit, all unchanged in
// their assertions). No DB: nothing here needs DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_JOB_URL } from './helpers/create-link-job.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(LINK_JOB_URL);
const { createAuthedLinkJob } = lib;

const USER = { user_id: '00000000-0000-4000-8000-000000000001' };
const URL_OK = 'https://youtu.be/dQw4w9WgXcQ';
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

class EntitlementError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'EntitlementError';
    this.code = code;
    this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402;
  }
}

const PLANS = {
  free: { plan_code: 'free', jobs_quota: 5, credits_remaining: 0 },
  freeCredits: { plan_code: 'free', jobs_quota: 5, credits_remaining: 3 },
  pro: { plan_code: 'pro', jobs_quota: 1_000_000, credits_remaining: 0 },
};

/**
 * A fake world.
 *   plan        PLANS key (entitlement snapshot)
 *   jobsUsed    entitlements.jobs_used at the start
 *   trialLeft   trial songs left (trial_grants)
 *   entRefusal  EntitlementError code enforceEntitlement throws
 *   admission   checkAdmission result
 *   burst       checkBurstLimit denial
 *   ipFull      the per-IP WHERE refuses (INSERT returns 0 rows)
 */
function world(o = {}) {
  const st = {
    jobs: [],
    jobsUsed: o.jobsUsed ?? 0,
    trialUsed: 0,
    trialLimit: o.trialLeft ?? 0,
    debits: [],
    burst: [],
  };
  const log = [];
  let seq = 0;
  let chain = Promise.resolve();
  const snapshot = () => structuredClone({ jobs: st.jobs, jobsUsed: st.jobsUsed, trialUsed: st.trialUsed, debits: st.debits });
  const restore = (s) => Object.assign(st, structuredClone(s));
  const select = (params) => {
    const row = st.jobs.find((j) => j.user === params[0] && j.url === params[1]);
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  };
  const client = {
    query: async (sql, params) => {
      if (/^INSERT INTO jobs/.test(sql)) {
        log.push('INSERT');
        assert.match(sql, /WHERE \(SELECT COUNT\(\*\) FROM jobs WHERE client_ip_hash = \$5/, 'the per-IP WHERE is on the INSERT');
        assert.equal(params[4], 'iphash');
        if (o.ipFull) return { rows: [], rowCount: 0 };
        st.jobs.push({ id: params[0], url: params[1], user: params[7], stems: params[2], bars: params[3] });
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/^SELECT existing/.test(sql)) return select(params);
      throw new Error('unexpected tx SQL: ' + sql);
    },
  };
  const db = {
    query: async (sql, params) => {
      if (/^SELECT existing/.test(sql)) return select(params);
      throw new Error('unexpected db.query SQL: ' + sql);
    },
    tx: (fn) => {
      const run = chain.then(async () => {
        const snap = snapshot();
        log.push('BEGIN');
        try {
          const r = await fn(client);
          log.push('COMMIT');
          return r;
        } catch (e) {
          restore(snap);
          log.push('ROLLBACK');
          throw e;
        }
      });
      chain = run.catch(() => {});
      return run;
    },
  };
  const plan = PLANS[o.plan ?? 'free'];
  const deps = {
    db,
    randomUUID: () => `job-${++seq}`,
    canonicalizeYoutubeUrl: (u) => (u === URL_OK || u === CANON ? CANON : null),
    checkAdmission: async (h) => {
      log.push('checkAdmission');
      assert.equal(h, 'iphash');
      return o.admission ?? { allowed: true, error_code: null };
    },
    RATE_LIMIT: 10,
    RATE_WINDOW_MS: 60_000,
    checkBurstLimit: async () => {
      log.push('checkBurstLimit');
      st.burst.push(1); // the attempt row is written outside the job tx, as in production
      return o.burst ?? null;
    },
    checkMonthlyQuota: async () => {
      log.push('checkMonthlyQuota');
      if (plan.plan_code === 'pro') return null;
      if (plan.credits_remaining > 0) return null; // the credit waiver (for uploads)
      return st.jobsUsed >= plan.jobs_quota ? { resets_at: '2026-12-01T00:00:00Z' } : null;
    },
    bumpJobsUsed: async () => { log.push('bumpJobsUsed'); st.jobsUsed += 1; },
    bumpJobsUsedWithinQuota: async (_c, _u, q) => {
      log.push('bumpJobsUsedWithinQuota');
      if (st.jobsUsed >= q) return false;
      st.jobsUsed += 1;
      return true;
    },
    recordAllowanceDebit: async (_c, _u, id, { trialSong }) => {
      log.push('recordAllowanceDebit');
      st.debits.push({ id, trialSong });
      return true;
    },
    rollPeriodIfStale: async () => { log.push('rollPeriodIfStale'); },
    getEntitlementSnapshot: async () => { log.push('getEntitlementSnapshot'); return { ...plan }; },
    enforceEntitlement: async (action) => {
      log.push('enforceEntitlement');
      assert.equal(action, 'start_job_youtube');
      if (o.entRefusal) throw new EntitlementError(o.entRefusal, 'internal reason');
    },
    EntitlementError,
    FREE_QUOTA_EXHAUSTED_MESSAGE: 'FREE_MSG',
    LINK_CAP_CREDITS_DETAIL: 'CREDITS_DETAIL',
    RATE_LIMIT_MSG: 'RATE_MSG',
    entitlementMessage: (code, msg) => `copy(${code}|${msg})`,
    consumeTrialInTx: async () => {
      log.push('consumeTrialInTx');
      if (st.trialUsed >= st.trialLimit) return { ok: false };
      st.trialUsed += 1;
      return { ok: true };
    },
    captureException: (e) => { log.push('captureException'); st.captured = e; },
    noteAllowanceDebitRecorded: () => {},
  };
  // The hooks a caller (B3) would pass: same user + canonical URL = the same song.
  const hooks = {
    findExisting: async (d, ctx) => {
      log.push('findExisting');
      assert.equal(d, db);
      return (await d.query('SELECT existing', [ctx.userId, ctx.canonicalUrl])).rows[0]?.id ?? null;
    },
    beforeInsert: async (c, ctx) => {
      log.push('beforeInsert');
      assert.equal(c, client, 'beforeInsert gets the tx client');
      return (await c.query('SELECT existing', [ctx.userId, ctx.canonicalUrl])).rows[0]?.id ?? null;
    },
  };
  const tap = (extra = {}) =>
    createAuthedLinkJob({ user: USER, url: URL_OK, clientIpHash: () => 'iphash', ...extra }, deps);
  const rows = () => ({ jobs: st.jobs.length, jobsUsed: st.jobsUsed, trialUsed: st.trialUsed, debits: st.debits.length, burst: st.burst.length });
  return { st, log, db, deps, hooks, tap, rows, client };
}

const withYoutube = (fn) => async () => {
  const prev = process.env.ALLOW_YOUTUBE_INPUT;
  process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.ALLOW_YOUTUBE_INPUT; else process.env.ALLOW_YOUTUBE_INPUT = prev;
  }
};

// ── AC2: every refusal keeps its status and body ─────────────────────────────────────────────

test('ALLOW_YOUTUBE_INPUT unset → 403, before any hook or gate', async () => {
  const prev = process.env.ALLOW_YOUTUBE_INPUT;
  for (const v of [undefined, 'false', '1']) {
    if (v === undefined) delete process.env.ALLOW_YOUTUBE_INPUT; else process.env.ALLOW_YOUTUBE_INPUT = v;
    const w = world({ trialLeft: 1 });
    const r = await w.tap(w.hooks);
    assert.deepEqual(r, {
      status: 403,
      body: { error_code: 'DOWNLOAD_INVALID_URL', message: 'YouTube links are paused right now. Upload the audio file instead.' },
    });
    assert.deepEqual(w.log, []);
    assert.deepEqual(w.rows(), { jobs: 0, jobsUsed: 0, trialUsed: 0, debits: 0, burst: 0 });
  }
  if (prev === undefined) delete process.env.ALLOW_YOUTUBE_INPUT; else process.env.ALLOW_YOUTUBE_INPUT = prev;
});

test('bad input → 400 with the same copy, before any hook or gate', withYoutube(async () => {
  const cases = [
    [{ url: undefined }, 'url is required'],
    [{ url: 42 }, 'url is required'],
    [{ url: '' }, 'url is required'],
    [{ url: 'https://example.com/x' }, 'That doesn’t look like a YouTube video link. Paste a full youtube.com or youtu.be link.'],
    [{ loopLengthBars: 3 }, 'loop_length_bars must be 1, 2, 4, or 8'],
    [{ stems: [] }, 'stems must be a non-empty list of supported stems.'],
    [{ stems: ['piano'] }, 'stems must be a non-empty list of supported stems.'],
    [{ stems: 'drums' }, 'stems must be a non-empty list of supported stems.'],
  ];
  for (const [extra, message] of cases) {
    const w = world({ trialLeft: 1 });
    const r = await w.tap({ ...w.hooks, ...extra });
    assert.deepEqual(r, { status: 400, body: { error_code: 'DOWNLOAD_INVALID_URL', message } }, JSON.stringify(extra));
    assert.deepEqual(w.log, []);
  }
}));

test('paid entitlement refusal is final: same status + copy, nothing spent', withYoutube(async () => {
  const w = world({ plan: 'pro', entRefusal: 'FREE_MONTHLY_QUOTA_EXHAUSTED' });
  const r = await w.tap();
  assert.deepEqual(r, { status: 402, body: { error_code: 'FREE_MONTHLY_QUOTA_EXHAUSTED', message: 'copy(FREE_MONTHLY_QUOTA_EXHAUSTED|internal reason)' } });
  assert.deepEqual(w.log, ['enforceEntitlement', 'getEntitlementSnapshot']);
  assert.deepEqual(w.rows(), { jobs: 0, jobsUsed: 0, trialUsed: 0, debits: 0, burst: 0 });
}));

test('a free account\'s entitlement refusal is not final: the gates below decide', withYoutube(async () => {
  const w = world({ plan: 'free', entRefusal: 'TRIAL_EXHAUSTED' });
  const r = await w.tap();
  assert.equal(r.status, 201);
}));

test('a non-entitlement error from the gate fails open and is reported', withYoutube(async () => {
  const w = world({ plan: 'free' });
  w.deps.enforceEntitlement = async () => { w.log.push('enforceEntitlement'); throw new Error('db down'); };
  const r = await w.tap();
  assert.equal(r.status, 201);
  assert.deepEqual(w.log.slice(0, 3), ['enforceEntitlement', 'captureException', 'checkAdmission']);
}));

test('admission: AT_CAPACITY → 503 + Retry-After; per-client → 429; nothing spent', withYoutube(async () => {
  const w = world({ trialLeft: 1, admission: { allowed: false, error_code: 'AT_CAPACITY', message: 'busy', retry_after_s: 30 } });
  assert.deepEqual(await w.tap(), { status: 503, body: { error_code: 'AT_CAPACITY', message: 'busy' }, headers: { 'Retry-After': '30' } });
  assert.deepEqual(w.rows(), { jobs: 0, jobsUsed: 0, trialUsed: 0, debits: 0, burst: 0 });
  const v = world({ trialLeft: 1, admission: { allowed: false, error_code: 'RATE_LIMITED', reason: 'per_client', message: 'slow down' } });
  assert.deepEqual(await v.tap(), { status: 429, body: { error_code: 'RATE_LIMITED', message: 'slow down' } });
  assert.deepEqual(v.rows(), { jobs: 0, jobsUsed: 0, trialUsed: 0, debits: 0, burst: 0 });
  assert.deepEqual(v.log, ['enforceEntitlement', 'checkAdmission']);
}));

test('the IP hash is computed just before checkAdmission, never earlier', withYoutube(async () => {
  const w = world({ trialLeft: 1 });
  let calls = 0;
  const r403 = await (async () => {
    delete process.env.ALLOW_YOUTUBE_INPUT;
    try { return await w.tap({ clientIpHash: () => { calls++; throw new Error('IP_HASH_KEY unset'); } }); }
    finally { process.env.ALLOW_YOUTUBE_INPUT = 'true'; }
  })();
  assert.equal(r403.status, 403);
  assert.equal(calls, 0);
  const order = [];
  w.deps.checkAdmission = async () => { order.push('checkAdmission'); return { allowed: true, error_code: null }; };
  await w.tap({ clientIpHash: () => { order.push('ip'); return 'iphash'; } });
  assert.deepEqual(order, ['ip', 'checkAdmission']);
}));

test('per-IP WHERE refuses: 429 RATE_LIMITED, and a trial song is not burned', withYoutube(async () => {
  const t = world({ trialLeft: 1, ipFull: true });
  assert.deepEqual(await t.tap(), { status: 429, body: { error_code: 'RATE_LIMITED', message: 'RATE_MSG' } });
  assert.deepEqual(t.rows(), { jobs: 0, jobsUsed: 0, trialUsed: 0, debits: 0, burst: 0 });
  const f = world({ ipFull: true });
  assert.deepEqual(await f.tap(), { status: 429, body: { error_code: 'RATE_LIMITED', message: 'RATE_MSG' } });
  assert.deepEqual(f.rows(), { jobs: 0, jobsUsed: 0, trialUsed: 0, debits: 0, burst: 1 });
}));

test('burst limit → the same raw 429 the route always sent', withYoutube(async () => {
  const w = world({ burst: { retry_after_s: 12 } });
  assert.deepEqual(await w.tap(), {
    status: 429,
    body: { error: 'too many requests', code: 'rate_limit_burst', retry_after_s: 12 },
    headers: { 'content-type': 'application/json', 'Retry-After': '12' },
    raw: true,
  });
}));

test('Free quota exhausted → 402 quota_exceeded; capped in the tx with the right copy', withYoutube(async () => {
  const w = world({ jobsUsed: 5 });
  assert.deepEqual(await w.tap(), { status: 402, body: { error: 'monthly quota reached', code: 'quota_exceeded', resets_at: '2026-12-01T00:00:00Z' } });
  assert.deepEqual(w.rows(), { jobs: 0, jobsUsed: 5, trialUsed: 0, debits: 0, burst: 1 });
  // A credit holder passes checkMonthlyQuota (the upload waiver) and is capped under the lock.
  const c = world({ plan: 'freeCredits', jobsUsed: 5 });
  assert.deepEqual(await c.tap(), { status: 402, body: { error_code: 'FREE_MONTHLY_QUOTA_EXHAUSTED', message: 'copy(FREE_MONTHLY_QUOTA_EXHAUSTED|CREDITS_DETAIL)' } });
  assert.deepEqual(c.rows(), { jobs: 0, jobsUsed: 5, trialUsed: 0, debits: 0, burst: 1 });
}));

// ── the gate order, with and without hooks (no hook after the INSERT) ───────────────────────

const TRIAL_ORDER = ['enforceEntitlement', 'checkAdmission', 'getEntitlementSnapshot',
  'BEGIN', 'consumeTrialInTx', 'beforeInsert', 'INSERT', 'bumpJobsUsed', 'recordAllowanceDebit', 'COMMIT'];
const FREE_ORDER = ['enforceEntitlement', 'checkAdmission', 'getEntitlementSnapshot',
  'BEGIN', 'consumeTrialInTx', 'COMMIT',
  'checkBurstLimit', 'checkMonthlyQuota',
  'BEGIN', 'beforeInsert', 'INSERT', 'rollPeriodIfStale', 'bumpJobsUsedWithinQuota', 'recordAllowanceDebit', 'COMMIT'];
const PAID_ORDER = ['enforceEntitlement', 'checkAdmission', 'getEntitlementSnapshot',
  'checkBurstLimit', 'checkMonthlyQuota',
  'BEGIN', 'beforeInsert', 'INSERT', 'rollPeriodIfStale', 'bumpJobsUsed', 'recordAllowanceDebit', 'COMMIT'];
const noHooks = (order) => order.filter((s) => s !== 'beforeInsert');

for (const [name, opts, order, debit] of [
  ['trial', { trialLeft: 1 }, TRIAL_ORDER, { trialSong: true }],
  ['Free allowance', {}, FREE_ORDER, { trialSong: false }],
  ['paid', { plan: 'pro' }, PAID_ORDER, { trialSong: false }],
]) {
  test(`${name} branch: 201, exact gate order, one job and one debit (with hooks)`, withYoutube(async () => {
    const w = world(opts);
    const r = await w.tap(w.hooks);
    assert.deepEqual(r, { status: 201, body: { id: 'job-1', status: 'queued' } });
    assert.deepEqual(w.log, ['findExisting', ...order]);
    assert.equal(w.st.jobs.length, 1);
    assert.deepEqual(w.st.jobs[0], { id: 'job-1', url: CANON, user: USER.user_id, stems: ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'], bars: 4 });
    assert.deepEqual(w.st.debits, [{ id: 'job-1', ...debit }]);
    assert.equal(w.st.jobsUsed, 1);
  }));
  test(`${name} branch: without hooks the order is the pre-B0 route's`, withYoutube(async () => {
    const w = world(opts);
    const r = await w.tap({ stems: ['bass'], loopLengthBars: 8 });
    assert.deepEqual(r, { status: 201, body: { id: 'job-1', status: 'queued' } });
    assert.deepEqual(w.log, noHooks(order));
    assert.deepEqual(w.st.jobs[0].stems, ['bass']);
    assert.equal(w.st.jobs[0].bars, 8);
  }));
}

// ── AC3: a hook hit answers 200 with the existing id and writes nothing ──────────────────────

const seedSong = (w) => w.st.jobs.push({ id: 'old-job', url: CANON, user: USER.user_id });

for (const [name, opts] of [['trial', { trialLeft: 1 }], ['Free allowance', { jobsUsed: 4 }], ['paid', { plan: 'pro' }]]) {
  test(`${name} branch: findExisting hit → 200 { id } before every gate, nothing written`, withYoutube(async () => {
    const w = world(opts);
    seedSong(w);
    const before = w.rows();
    assert.deepEqual(await w.tap(w.hooks), { status: 200, body: { id: 'old-job' } });
    assert.deepEqual(w.log, ['findExisting']);
    assert.deepEqual(w.rows(), before);
  }));

  test(`${name} branch: beforeInsert hit → 200 { id }, tx rolled back, nothing charged`, withYoutube(async () => {
    const w = world(opts);
    // The song exists, but only the in-tx re-check is passed (as when it was committed between
    // hook 1 and the tx).
    seedSong(w);
    const before = w.rows();
    const r = await w.tap({ beforeInsert: w.hooks.beforeInsert });
    assert.deepEqual(r, { status: 200, body: { id: 'old-job' } });
    const after = w.rows();
    assert.equal(after.jobs, before.jobs, 'no new job');
    assert.equal(after.jobsUsed, before.jobsUsed);
    assert.equal(after.trialUsed, before.trialUsed, 'a trial consume is undone');
    assert.equal(after.debits, before.debits);
    assert.ok(!w.log.includes('INSERT'));
    assert.equal(w.log.at(-1), 'ROLLBACK');
    if (name === 'trial') {
      // Never falls through to burst/quota the way consumed:false does.
      assert.equal(after.burst, 0);
      assert.ok(!w.log.includes('checkBurstLimit') && !w.log.includes('checkMonthlyQuota'));
    } else {
      assert.equal(after.burst, 1, 'the one burst attempt is the documented residue');
    }
  }));

  test(`${name} branch: a beforeInsert that throws rolls back with nothing spent`, withYoutube(async () => {
    const w = world(opts);
    const before = w.rows();
    const boom = new Error('hook failed');
    await assert.rejects(w.tap({ beforeInsert: async () => { w.log.push('beforeInsert'); throw boom; } }), (e) => e === boom);
    const after = w.rows();
    assert.deepEqual({ ...after, burst: 0 }, { ...before, burst: 0 });
    assert.equal(w.log.at(-1), 'ROLLBACK');
    assert.equal(w.log.filter((s) => s === 'beforeInsert').length, 1, 'never retried on another branch');
    if (name === 'trial') assert.equal(after.burst, 0, 'no fall-through to burst/quota');
  }));
}

test('double tap at quota (1 song left): tap 1 → 201, tap 2 → 200 same id, not 402, nothing written', withYoutube(async () => {
  const w = world({ jobsUsed: 4 });
  const one = await w.tap(w.hooks);
  assert.deepEqual(one, { status: 201, body: { id: 'job-1', status: 'queued' } });
  const mid = w.rows();
  assert.deepEqual(mid, { jobs: 1, jobsUsed: 5, trialUsed: 0, debits: 1, burst: 1 });
  const two = await w.tap(w.hooks);
  assert.deepEqual(two, { status: 200, body: { id: 'job-1' } });
  assert.deepEqual(w.rows(), mid);
}));

for (const [name, opts] of [['trial', { trialLeft: 2 }], ['Free allowance', { jobsUsed: 4 }], ['paid', { plan: 'pro' }]]) {
  test(`${name} branch: two simultaneous taps → ≤ 1 job and ≤ 1 debit, both get the same id`, withYoutube(async () => {
    const w = world(opts);
    const [a, b] = await Promise.all([w.tap(w.hooks), w.tap(w.hooks)]);
    assert.equal(w.st.jobs.length, 1);
    assert.equal(w.st.debits.length, 1);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.id, b.body.id);
    assert.ok(w.st.trialUsed <= 1);
  }));
}

test('the trial consumed:false outcome still falls through to the non-trial path (unchanged)', withYoutube(async () => {
  const w = world({ trialLeft: 0 });
  const r = await w.tap();
  assert.equal(r.status, 201);
  assert.deepEqual(w.st.debits, [{ id: 'job-1', trialSong: false }]);
}));

test('an unexpected trial failure is reported and falls through (unchanged)', withYoutube(async () => {
  const w = world({ trialLeft: 1 });
  w.deps.consumeTrialInTx = async () => { throw new Error('trial table gone'); };
  const r = await w.tap();
  assert.equal(r.status, 201);
  assert.ok(w.log.includes('captureException'));
  assert.deepEqual(w.st.debits, [{ id: 'job-1', trialSong: false }]);
}));

// ── the lib's copies of the route's input constants stay equal ───────────────────────────────

test('the lib validates bars and stems exactly as the route does for uploads and anonymous links', () => {
  const route = readFileSync(join(WEB, 'src/app/api/jobs/route.ts'), 'utf8');
  assert.match(route, /const VALID_BARS = new Set\(\[1, 2, 4, 8\]\);/);
  assert.match(route, /const DEFAULT_STEMS = \['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'\];/);
  assert.deepEqual([...lib.LINK_VALID_BARS], [1, 2, 4, 8]);
  assert.deepEqual([...lib.LINK_DEFAULT_STEMS], ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other']);
  // The route sends every signed-in link request to the lib, and only those.
  assert.match(route, /if \(user\) \{\s*const r = await createAuthedLinkJob\(/);
});
