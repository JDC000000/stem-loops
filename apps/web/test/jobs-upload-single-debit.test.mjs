// POST /api/jobs (upload) must debit ONE thing per job — and must still roll
// the monthly period forward whatever funded the job.
//
// The original defect: inside the jobs-insert tx the route ran
//     if (chargeCredit) await consumeCreditInTx(...)   // spends a credit
//     await incrementJobsUsed(...)                     // ALSO spends a quota unit
// so a credit-funded job burned a credit AND a unit of the monthly allowance.
// checkMonthlyQuota() waives the quota check "while credits remain" (review M1),
// which hides it — until the credits run out and the user finds the allowance
// they never used already spent by the jobs the credits paid for.
//
// The fix is NOT "skip incrementJobsUsed". That one UPSERT did two unrelated
// jobs: it rolled period_start/period_end forward when they were stale, AND it
// metered the allowance. rate-limit.ts is the only period roller an account
// without an active subscription ever gets, and every quota gate sits upstream
// of it — so skipping the whole UPSERT on the credit path traded a double debit
// for a permanent lockout (adversarial review of #233, Finding A). The two
// concerns are now two functions: rollPeriodIfStale() on every authed upload,
// bumpJobsUsed() only when the allowance is what funds the job.
//
// Instrument: this is NOT a stubbed-collaborator test. The real route.ts,
// entitlements.ts, rate-limit.ts and credits.ts all run; only the database is
// replaced, by a stateful fake that interprets the statements those modules
// issue and rolls back on a throw. Assertions are on the LEDGER (credit
// consumption rows, jobs_used, job rows), not on which functions were called.
// An unrecognised SQL statement throws, so the fake cannot silently drift from
// the code under test.
//
// What the fake now models that it did not before (round-2 review):
//   • Per-user state. entitlements is keyed BY user_id and the jobs /
//     credit_consumption rows carry theirs, so a debit against the wrong
//     account is visible instead of invisible (it was `if (f.ent) …`, which
//     ignored params entirely).
//   • v_credit_balance as the DERIVED view it is:
//     GREATEST(0, SUM(purchases) + SUM(adjustments) − COUNT(consumption)),
//     per migration 023. The balance is never a stored integer here either.
//   • The balance guard's comparison is READ OUT OF THE STATEMENT credits.ts
//     issues, not reimplemented. Changing `> 0` to `>= 0` in credits.ts
//     changes what this fake does, which is the only way a JS fake can test a
//     SQL predicate instead of replacing it.
//   • check_credit_decrement (migration 013): the job must exist, be
//     input_kind='upload', and belong to the same user; UNIQUE (job_id).
//   • The per-IP rate limit in the authed INSERT's own WHERE, so the insert
//     can return rowCount 0 — the "refused ⇒ nothing debited" path, which had
//     no coverage anywhere in apps/web.
//   • Period rollover: both the roller's conditional UPDATE and the bumper's
//     ON CONFLICT CASE arms, with the staleness comparison taken from the
//     statement text.
//
// A throw out of the route is captured as data (status 0) rather than allowed
// to error the test out: the route's contract is to answer with a status, so a
// mutant that makes it explode has to fail an assertion here.
//
// Quotas below are the values PR #210 (migration 034) sets: free 5, pro 50,
// studio 150. They are fixture data here, not read from the migration.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(WEB, 'src', p);

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => toJs(readFileSync(SRC(p), 'utf8'));

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER_JOB = '99999999-9999-9999-9999-999999999999';
const PLANS = {
  free: { code: 'free', monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false },
  pro: { code: 'pro', monthly_job_quota: 50, services: [], export_stems: false, export_wav24: false },
  studio: { code: 'studio', monthly_job_quota: 150, services: [], export_stems: true, export_wav24: false },
};

// Per-IP cap the admission stub reports to the route, i.e. the `$8` the
// authed INSERT compares its window count against. Deliberately far above any
// request count in this file, so the cap is exercised by seeding the window
// (`ipWindow`) rather than by issuing a thousand requests.
const IP_CAP = 1000;

// Real wall-clock periods. A current period must really contain now() and a
// stale one must really be over, or the rollover arms are unreachable — which
// is exactly how the first round of this file missed Finding A (it pinned
// period_end at 2099-01-01).
const N = new Date();
const CUR_START = new Date(Date.UTC(N.getUTCFullYear(), N.getUTCMonth(), 1)).toISOString();
const CUR_END = new Date(Date.UTC(N.getUTCFullYear(), N.getUTCMonth() + 1, 1)).toISOString();
const STALE_START = new Date(Date.UTC(N.getUTCFullYear(), N.getUTCMonth() - 2, 1)).toISOString();
const STALE_END = new Date(Date.UTC(N.getUTCFullYear(), N.getUTCMonth() - 1, 1)).toISOString();

// ---------------------------------------------------------------------------
// The fake database (shared via globalThis so every data: module sees it).
// ---------------------------------------------------------------------------
const dbStub = dataUrl(`
  const F = () => globalThis.__fake;
  const PLANS = ${JSON.stringify(PLANS)};
  const CUR_START = ${JSON.stringify(CUR_START)};
  const CUR_END = ${JSON.stringify(CUR_END)};
  const ok = (rows = []) => ({ rows, rowCount: rows.length });
  const no = () => ({ rows: [], rowCount: 0 });
  const NOW = () => Date.now();

  /** Evaluate "<lhs> <op> <rhs>" for the comparison operators Postgres and
   *  these statements actually use. The operator is always one the fake read
   *  out of the SQL, never one it chose. */
  const cmp = (op, a, b) =>
    op === '<=' ? a <= b : op === '<' ? a < b :
    op === '>=' ? a >= b : op === '>' ? a > b : a === b;

  /** v_credit_balance (migration 023), derived — never a stored integer:
   *  GREATEST(0, SUM(credits_granted) + SUM(credits_delta) - COUNT(consumption)). */
  function balance(userId) {
    const f = F();
    const g = f.purchases.filter((p) => p.user_id === userId)
      .reduce((a, p) => a + p.credits_granted, 0);
    const d = f.adjustments.filter((a2) => a2.user_id === userId)
      .reduce((a, x) => a + x.credits_delta, 0);
    const c = f.consumption.filter((x) => x.user_id === userId).length;
    return Math.max(0, g + d - c);
  }
  globalThis.__fakeApi = { balance };

  /** users.id is the FK target of entitlements.user_id, credit_consumption
   *  .user_id and jobs.user_id. An unknown uuid is a FK violation, not a
   *  silently-created second account. */
  function requireUser(userId, what) {
    if (!F().users.includes(userId)) {
      throw new Error('fake db: FK violation: ' + what + '.user_id ' + userId + ' is not in users');
    }
  }

  function handle(sql, params) {
    const f = F();
    const s = sql.replace(/\\s+/g, ' ').trim();
    f.sql.push(s.slice(0, 70));

    if (/pg_advisory_xact_lock/.test(s)) {
      // Record WHICH lock and WHOSE: (tag, user_id) are $1, $2 for all three
      // callers (job_quota, job_burst, credit_consume).
      f.locks.push({ tag: params[0], user: params[1] });
      return ok([{}]);
    }

    if (/^INSERT INTO credit_consumption/.test(s)) {
      // The double-spend defence is the conditional INSERT's own WHERE. Take
      // the operator and the literal from the statement so that mutating them
      // in credits.ts mutates this guard too.
      const m = /\\(SELECT credits_remaining FROM v_credit_balance WHERE user_id = \\$1::uuid\\)\\s*(<=|<|>=|>|=)\\s*(-?\\d+)/.exec(s);
      if (!m) throw new Error('fake db: credit_consumption INSERT has no recognised balance predicate: ' + s.slice(0, 160));
      if (!cmp(m[1], balance(params[0]), Number(m[2]))) return no();

      // check_credit_decrement (migration 013) + UNIQUE (job_id).
      requireUser(params[0], 'credit_consumption');
      const job = f.jobs.find((j) => j.id === params[1]);
      if (!job) throw new Error('credit_consumption rejected: job ' + params[1] + ' not found');
      if (job.input_kind !== 'upload') {
        throw new Error('credit_consumption rejected: job ' + params[1] + ' is not input_kind=upload');
      }
      if (job.user_id !== null && job.user_id !== params[0]) {
        throw new Error('credit_consumption rejected: NEW.user_id ' + params[0] +
                        ' does not match jobs.user_id ' + job.user_id);
      }
      if (f.consumption.some((x) => x.job_id === params[1])) {
        throw new Error('duplicate key value violates unique constraint "credit_consumption_job_id_key"');
      }
      f.consumption.push({ user_id: params[0], job_id: params[1] });
      return ok([{ id: 'c' + f.consumption.length }]);
    }

    if (/^INSERT INTO jobs/.test(s)) {
      // The per-IP rate limit IS this statement's WHERE: refuse with 0 rows
      // when the window is already at the cap the statement carries in $8.
      const authed = /\\$9::uuid/.test(s);
      const ipHash = params[5];
      const cap = params[7];
      const inWindow = f.ipWindow + f.jobs.filter((j) => j.client_ip_hash === ipHash).length;
      if (!(inWindow < cap)) return no();
      const userId = authed ? params[8] : null;
      if (userId !== null) requireUser(userId, 'jobs');
      const kind = /'upload'/.test(s) ? 'upload' : 'youtube';
      f.jobs.push({ id: params[0], input_kind: kind, user_id: userId, client_ip_hash: ipHash });
      return ok([{ id: params[0] }]);
    }

    if (/^UPDATE entitlements/.test(s)) {
      // rollPeriodIfStale(): period bookkeeping only. Conditional UPDATE, so
      // a user with no row has nothing rolled (0 rows is the correct answer).
      if (!/period_start = date_trunc/.test(s)) {
        throw new Error('fake db: unrecognised UPDATE entitlements: ' + s.slice(0, 160));
      }
      const m = /period_end\\s*(<=|<|>=|>)\\s*now\\(\\)/.exec(s);
      if (!m) throw new Error('fake db: roll UPDATE has no recognised staleness predicate: ' + s.slice(0, 160));
      const row = f.ents[params[0]];
      if (!row || !cmp(m[1], Date.parse(row.period_end), NOW())) return no();
      const setsUsed = /jobs_used\\s*=\\s*(\\d+)/.exec(s);
      row.jobs_used = setsUsed ? Number(setsUsed[1]) : row.jobs_used;
      row.period_start = CUR_START;
      row.period_end = CUR_END;
      f.rolls.push(params[0]);
      return { rows: [], rowCount: 1 };
    }

    if (/^INSERT INTO entitlements/.test(s)) {
      // bumpJobsUsed(): metering. UPSERT — seeds the row when absent, else the
      // ON CONFLICT CASE arms (stale ⇒ reset to 1 and roll, else +1).
      requireUser(params[0], 'entitlements');
      // bumpJobsUsedWithinQuota(): the capped variant. ON CONFLICT DO UPDATE
      // ... WHERE <cap>: the row is bumped only while under the cap the
      // statement carries in $2, else 0 rows. Operator read from the SQL.
      const capped = /DO UPDATE SET jobs_used = entitlements\\.jobs_used \\+ 1 WHERE entitlements\\.jobs_used\\s*(<=|<|>=|>)\\s*\\$2/.exec(s);
      if (capped) {
        const cur = f.ents[params[0]];
        if (!cur) {
          f.bumps.push(params[0]);
          f.ents[params[0]] = { plan_code: 'free', jobs_used: 1, sub_status: null, period_start: CUR_START, period_end: CUR_END };
          return ok([{ jobs_used: 1 }]);
        }
        if (!cmp(capped[1], cur.jobs_used, Number(params[1]))) return no();
        f.bumps.push(params[0]);
        cur.jobs_used += 1;
        return ok([{ jobs_used: cur.jobs_used }]);
      }
      f.bumps.push(params[0]);
      const row = f.ents[params[0]];
      if (!row) {
        f.ents[params[0]] = {
          plan_code: 'free', jobs_used: 1, sub_status: null,
          period_start: CUR_START, period_end: CUR_END,
        };
        return ok();
      }
      const m = /WHEN entitlements.period_end\\s*(<=|<|>=|>)\\s*now\\(\\) THEN 1/.exec(s);
      if (!m) throw new Error('fake db: bump UPSERT has no recognised staleness arm: ' + s.slice(0, 200));
      if (cmp(m[1], Date.parse(row.period_end), NOW())) {
        row.jobs_used = 1;
        row.period_start = CUR_START;
        row.period_end = CUR_END;
        f.rolls.push(params[0]);
      } else {
        row.jobs_used += 1;
      }
      return ok();
    }

    if (/FROM usage_events/.test(s)) return ok([{ n: '0' }]);
    if (/^INSERT INTO usage_events/.test(s)) return ok();
    if (/FROM entitlements e/.test(s)) {
      const row = f.ents[params[0]];
      return row ? ok([{ ...row, sub_period_start: row.period_start }]) : ok();
    }
    if (/FROM v_credit_balance/.test(s)) return ok([{ credits_remaining: balance(params[0]) }]);
    if (/FROM trial_grants/.test(s)) return ok();
    if (/FROM plans/.test(s)) {
      // A test may override the plan rows (e.g. a zero-quota fixture); default = PLANS.
      const P = f.plans ?? PLANS;
      return ok(P[params[0]] ? [P[params[0]]] : []);
    }
    throw new Error('fake db: unrecognised SQL: ' + s.slice(0, 120));
  }

  const client = { query: async (sql, params) => handle(sql, params) };
  const KEYS = ['ents', 'jobs', 'purchases', 'adjustments', 'consumption', 'locks', 'bumps', 'rolls'];
  export const db = {
    query: async (sql, params) => handle(sql, params),
    tx: async (fn) => {
      const f = F();
      const before = JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, f[k]])));
      try { return await fn(client); }
      catch (e) { Object.assign(f, JSON.parse(before)); throw e; }
    },
  };
`);

const stub = {
  auth: dataUrl(`export const getUser = async () => ({ user_id: '${USER}', email: 'u@x.co' });`),
  trial: dataUrl(`export const TRIAL_SONG_CAP = 3; export const consumeTrialInTx = async () => ({ ok: false });`),
  admission: dataUrl(`
    export const checkAdmission = async () => ({ allowed: true, error_code: null });
    export const RATE_WINDOW_MS = 60000; export const RATE_LIMIT = ${IP_CAP};`),
  clientIp: dataUrl(`export const clientIpHashOf = () => 'hash';`),
  ytUrl: dataUrl(`export const canonicalizeYoutubeUrl = (u) => u;`),
  upload: dataUrl(`export const isValidUploadKey = () => true;`),
  sentry: dataUrl(`export const captureException = () => {};`),
  next: dataUrl(`
    export class NextResponse {
      constructor(body, init) { this._b = body; this.status = (init && init.status) || 200; }
      static json(obj, init) { const r = new NextResponse(JSON.stringify(obj), init); r.body = obj; return r; }
      async json() { return this.body ?? JSON.parse(this._b); }
    }
    export class NextRequest {}`),
};

// One module graph: a single entitlements instance, so EntitlementError is the
// same class everywhere and the snapshot cache is shared.
const ENT = dataUrl(read('lib/billing/entitlements.ts').replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`));
const CREDITS = dataUrl(
  read('lib/billing/credits.ts').replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ENT}'`),
);
const RATE = dataUrl(
  read('lib/billing/rate-limit.ts')
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]\.\/entitlements['"]/g, `from '${ENT}'`),
);
const ROUTE = dataUrl(
  read('app/api/jobs/route.ts')
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${stub.auth}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${stub.trial}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ENT}'`)
    .replace(/from ['"]@\/lib\/billing\/credits['"]/g, `from '${CREDITS}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${RATE}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${stub.admission}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${stub.clientIp}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${stub.ytUrl}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${stub.upload}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${stub.sentry}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${stub.next}'`),
);
const route = await import(ROUTE);
const ent = await import(ENT);

let seq = 0;
const jobId = () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++seq).padStart(12, '0')}`;

/** POST one upload. A throw out of the route is returned as status 0 rather
 *  than left to error the test out: the route's contract is to answer with a
 *  status, so "it exploded" has to be assertable, not a crash. (Rule: a
 *  mutant that dies by crashing is not killed.) */
const post = async () => {
  const id = jobId();
  try {
    const r = await route.POST({
      json: async () => ({ jobId: id, uploadKey: `${id}/_input.mp3`, loop_length_bars: 4 }),
      headers: new Map(),
    });
    return { status: r.status, body: await r.json(), jobId: id };
  } catch (err) {
    return { status: 0, body: { error_code: 'THREW', message: String(err?.message ?? err) }, jobId: id };
  }
};

/** Seed the ledger. `jobsUsed: null` = no entitlements row yet.
 *  `credits` is seeded as a credit_purchases row, not a stored balance —
 *  the balance is derived, as in production. */
function seed({
  plan = 'free', credits = 0, jobsUsed = 0, billing = false,
  periodStart = CUR_START, periodEnd = CUR_END, ipWindow = 0, plans = undefined,
}) {
  globalThis.__fake = {
    users: [USER],
    ents: jobsUsed === null ? {} : {
      [USER]: {
        plan_code: plan, jobs_used: jobsUsed,
        sub_status: plan === 'free' ? null : 'active',
        period_start: periodStart, period_end: periodEnd,
      },
    },
    purchases: credits ? [{ user_id: USER, credits_granted: credits }] : [],
    adjustments: [],
    consumption: [],
    jobs: [], locks: [], bumps: [], rolls: [], sql: [],
    ipWindow,
    plans,
  };
  if (billing) process.env.BILLING_ENFORCED = 'true';
  else delete process.env.BILLING_ENFORCED;
  ent._resetEntitlementCacheForTests(); // each request below is "30 s later"
}
const f = () => globalThis.__fake;
const ledger = () => ({
  credits: globalThis.__fakeApi.balance(USER),
  jobs_used: f().ents[USER]?.jobs_used ?? 0,
  jobs: f().jobs.length,
});
const quotaLocks = () => f().locks.filter((l) => l.tag === 'job_quota').map((l) => l.user);
async function run(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    ent._resetEntitlementCacheForTests();
    out.push(await post());
  }
  return out;
}

beforeEach(() => { delete process.env.BILLING_ENFORCED; });

// ---------------------------------------------------------------------------
// 1. A credit-funded job debits exactly one thing: the credit.
// ---------------------------------------------------------------------------
test('credit-funded job: one credit spent, monthly quota untouched', async () => {
  seed({ plan: 'free', credits: 3, jobsUsed: 0 });
  const [r] = await run(1);
  assert.equal(r.status, 201);
  assert.deepEqual(ledger(), { credits: 2, jobs_used: 0, jobs: 1 });
});

test('credit-funded job, billing enforced: one credit spent, quota untouched', async () => {
  seed({ plan: 'free', credits: 3, jobsUsed: 0, billing: true });
  const [r] = await run(1);
  assert.equal(r.status, 201);
  assert.deepEqual(ledger(), { credits: 2, jobs_used: 0, jobs: 1 });
});

test('credit-funded job with no entitlements row yet creates no quota row', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: null });
  const [r] = await run(1);
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(f().ents), [], 'a credit job must not seed a quota counter');
  assert.deepEqual(f().rolls, [], 'there is no period to roll for a user with no row');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 0, jobs: 1 });
});

// ---------------------------------------------------------------------------
// 2. A quota-funded job debits exactly one thing: the quota unit.
// ---------------------------------------------------------------------------
test('quota-funded free job (billing off, 0 credits): one quota unit, no credit', async () => {
  seed({ plan: 'free', credits: 0, jobsUsed: 0 });
  const [r] = await run(1);
  assert.equal(r.status, 201);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 1, jobs: 1 });
});

for (const plan of ['pro', 'studio']) {
  test(`${plan} job (quota-funded) debits one quota unit even when the account holds credits`, async () => {
    // Subscribers never pay in credits: chargeCredit is false for pro/studio,
    // so held credits are left alone and the job is metered by quota alone.
    seed({ plan, credits: 3, jobsUsed: 7 });
    const [r] = await run(1);
    assert.equal(r.status, 201);
    assert.deepEqual(ledger(), { credits: 3, jobs_used: 8, jobs: 1 });
  });
}

// ---------------------------------------------------------------------------
// 3. The boundary: credits run out mid-month.
// ---------------------------------------------------------------------------
test('boundary: credits spent first leave the whole free allowance intact', async () => {
  // free quota 5 (migration 034), 3 credits. Three credit jobs, then the
  // allowance must still serve 5 jobs and refuse the 6th.
  seed({ plan: 'free', credits: 3, jobsUsed: 0 });
  const credited = await run(3);
  assert.deepEqual(credited.map((r) => r.status), [201, 201, 201]);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 0, jobs: 3 });

  const quota = await run(6);
  assert.deepEqual(quota.map((r) => r.status), [201, 201, 201, 201, 201, 402]);
  assert.equal(quota[5].body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 5, jobs: 8 });
});

test('boundary: allowance partly used, then credits spent, then allowance finishes', async () => {
  seed({ plan: 'free', credits: 2, jobsUsed: 4 }); // 1 quota unit left
  const r = await run(5);
  // Two credit-funded jobs (quota check waived while credits remain), then the
  // one remaining quota unit, then the 402.
  assert.deepEqual(r.map((x) => x.status), [201, 201, 201, 402, 402]);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 5, jobs: 3 });
});

test('boundary: a credit holder already AT quota is still served by credits, quota unchanged', async () => {
  seed({ plan: 'free', credits: 2, jobsUsed: 5 });
  const r = await run(3);
  assert.deepEqual(r.map((x) => x.status), [201, 201, 402]);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 5, jobs: 2 });
});

test('boundary, billing enforced: lost race for the last credit -> 402, nothing debited, no job row', async () => {
  // The snapshot (30 s cache) still says 1 credit; the ledger says 0 because
  // another request already inserted the consumption row. The refusal comes
  // from the conditional INSERT's own WHERE, evaluated against the derived
  // balance — not from the cached snapshot. With BILLING_ENFORCED=true a
  // credit is the only currency, so 402 is right. (Billing OFF: next tests.)
  seed({ plan: 'free', credits: 1, jobsUsed: 0, billing: true });
  await ent.getEntitlementSnapshot(USER); // prime the cache with credits_remaining = 1
  f().consumption.push({ user_id: USER, job_id: OTHER_JOB }); // another request took it
  assert.equal(globalThis.__fakeApi.balance(USER), 0);
  const r = await post();
  assert.equal(r.status, 402);
  assert.equal(r.body.error_code, 'CREDIT_BALANCE_INSUFFICIENT');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 0, jobs: 0 });
  assert.deepEqual(f().consumption, [{ user_id: USER, job_id: OTHER_JOB }], 'no second consumption row');
});

// W2 overnight QA (2026-11-12), reproduced 3/3 over HTTP against the real
// route: with billing NOT enforced (production today), a free account that
// spends its LAST credit and uploads again inside the 30 s snapshot TTL — or
// fires two uploads at once with one credit left — is refused 402 with the
// bare string "CREDIT_BALANCE_INSUFFICIENT", although its whole monthly
// allowance is unused and no credit can be bought. That is the defect the
// `billingEnforced() || credits_remaining > 0` predicate exists to prevent;
// the stale cache re-creates it. The allowance is the fallback, and it is
// capped under the quota lock, so the fallback cannot overshoot the quota.
test('billing off: lost the last-credit race -> served by the allowance (one unit, no credit)', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: 0 });
  await ent.getEntitlementSnapshot(USER); // cache says credits_remaining = 1
  f().consumption.push({ user_id: USER, job_id: OTHER_JOB }); // another request took it
  const r = await post();
  assert.equal(r.status, 201, `expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 1, jobs: 1 });
  assert.deepEqual(f().consumption, [{ user_id: USER, job_id: OTHER_JOB }], 'no second consumption row');
});

test('billing off: lost the last-credit race with the allowance spent -> 402 FREE_MONTHLY_QUOTA_EXHAUSTED, nothing debited', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: 5 });
  await ent.getEntitlementSnapshot(USER);
  f().consumption.push({ user_id: USER, job_id: OTHER_JOB });
  const r = await post();
  assert.equal(r.status, 402);
  assert.equal(r.body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.equal(r.body.message, ent.FREE_QUOTA_EXHAUSTED_MESSAGE, 'a message, not a bare code');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 5, jobs: 0 });
});

test('billing off: last credit spent, next upload inside the cache TTL -> allowance, not 402', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: 0 });
  const a = await post(); // credit-funded; snapshot cached with credits_remaining = 1
  const b = await post(); // same cache window: the HTTP repro, 1 s apart
  assert.deepEqual([a.status, b.status], [201, 201], JSON.stringify(b.body));
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 1, jobs: 2 });
});

// Review of #236 (M-9): pin the fallback's upper boundary, its lock, and the
// zero-quota guard, each of which a mutant of the fix got past.
test('billing off: lost the last-credit race at quota-1 -> the LAST allowance unit serves it; the next is refused', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: 4 }); // free quota 5: exactly one unit left
  await ent.getEntitlementSnapshot(USER);
  f().consumption.push({ user_id: USER, job_id: OTHER_JOB });
  const a = await post();
  assert.equal(a.status, 201, `expected 201, got ${a.status} ${JSON.stringify(a.body)}`);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 5, jobs: 1 });
  const b = await post(); // same cache window: snapshot still says 1 credit
  assert.equal(b.status, 402);
  assert.equal(b.body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 5, jobs: 1 }, 'the refusal debits nothing');
});

test('billing off: the allowance fallback takes the per-(user, period) quota lock', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: 0 });
  await ent.getEntitlementSnapshot(USER);
  f().consumption.push({ user_id: USER, job_id: OTHER_JOB });
  const r = await post();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // rollPeriodIfStale() takes it once; the capped bump must take it again.
  assert.deepEqual(quotaLocks(), [USER, USER]);
});

test('billing off: zero-quota plan, no entitlements row -> the fallback refuses rather than seed jobs_used = 1', async () => {
  seed({
    plan: 'free', credits: 1, jobsUsed: null,
    plans: { ...PLANS, free: { ...PLANS.free, monthly_job_quota: 0 } },
  });
  await ent.getEntitlementSnapshot(USER);
  f().consumption.push({ user_id: USER, job_id: OTHER_JOB });
  const r = await post();
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(r.body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.deepEqual(Object.keys(f().ents), [], 'no quota row brought into existence');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 0, jobs: 0 });
});

test('billing enforced, free, 0 credits: refused, nothing debited', async () => {
  seed({ plan: 'free', credits: 0, jobsUsed: 0, billing: true });
  const [r] = await run(1);
  assert.equal(r.status, 402);
  assert.equal(r.body.error_code, 'CREDIT_BALANCE_INSUFFICIENT');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 0, jobs: 0 });
});

// ---------------------------------------------------------------------------
// 4. Rate-limited ⇒ NOTHING debited.
//
// The authed upload INSERT is conditional: the per-IP limit lives in its
// WHERE, so a refusal returns rowCount 0 — NOT null. Everything inside the
// `if (r.rowCount)` guard must therefore not run, and the 429 must leave the
// ledger exactly as it was. Before this round nothing in apps/web drove this
// insert to 0 rows at all, on either branch, which is what let a guard of
// `if (r.rowCount !== null)` and a credit debit hoisted out of the guard both
// survive the whole suite.
// ---------------------------------------------------------------------------
test('rate-limited credit-funded upload: 429, no credit spent, no job row', async () => {
  seed({ plan: 'free', credits: 2, jobsUsed: 0, ipWindow: IP_CAP });
  const r = await post();
  assert.equal(r.status, 429, `expected a 429, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error_code, 'RATE_LIMITED');
  assert.deepEqual(ledger(), { credits: 2, jobs_used: 0, jobs: 0 });
  assert.deepEqual(f().consumption, [], 'a refused request must not reach the credit ledger');
  assert.deepEqual(f().bumps, [], 'a refused request must not meter the allowance');
  assert.deepEqual(f().rolls, [], 'a refused request must not move the period');
});

test('rate-limited quota-funded upload: 429, no allowance unit spent, no job row', async () => {
  // The silent-charge case: jobs_used + 1 committing behind a 429 means the
  // user is refused AND loses a unit of a 5-unit allowance.
  seed({ plan: 'free', credits: 0, jobsUsed: 2, ipWindow: IP_CAP });
  const r = await post();
  assert.equal(r.status, 429, `expected a 429, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error_code, 'RATE_LIMITED');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 2, jobs: 0 });
  assert.deepEqual(f().bumps, [], 'a refused request must not meter the allowance');
});

test('the per-IP cap is the statement own WHERE: last slot serves, next is refused', async () => {
  // One slot left in the window: that request is served and debited. The row
  // it inserts fills the window, so the next one is refused and debits
  // nothing. Both sides of `< $8` are exercised by the real statement.
  seed({ plan: 'free', credits: 0, jobsUsed: 0, ipWindow: IP_CAP - 1 });
  const a = await post();
  assert.equal(a.status, 201);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 1, jobs: 1 });
  ent._resetEntitlementCacheForTests();
  const b = await post();
  assert.equal(b.status, 429);
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 1, jobs: 1 });
});

// ---------------------------------------------------------------------------
// 5. WHOSE debit, and against WHICH job.
//
// "One job, one debit" is a claim about identity as much as about count. The
// fake keys entitlements by user_id and records the consumption row's
// (user_id, job_id), so a debit landing on the wrong account or naming the
// wrong job is visible here instead of only in production, where it is an FK
// violation or a trigger RAISE.
// ---------------------------------------------------------------------------
test('identity: the consumption row names THIS job and THIS user', async () => {
  seed({ plan: 'free', credits: 2, jobsUsed: 0 });
  const r = await post();
  assert.equal(r.status, 201, `expected a 201, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(f().consumption, [{ user_id: USER, job_id: r.jobId }]);
  assert.deepEqual(f().jobs.map((j) => ({ id: j.id, kind: j.input_kind, user: j.user_id })),
    [{ id: r.jobId, kind: 'upload', user: USER }]);
});

test('identity: the allowance bump moves THIS user counter, and nobody else gets a row', async () => {
  seed({ plan: 'free', credits: 0, jobsUsed: 0 });
  const r = await post();
  assert.equal(r.status, 201, `expected a 201, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(Object.keys(f().ents), [USER], 'no entitlements row for any other user_id');
  assert.deepEqual(f().bumps, [USER], 'the bump was issued for this user');
  assert.deepEqual(quotaLocks(), [USER, USER], 'roll + bump each took the quota lock for this user');
  assert.equal(f().ents[USER].jobs_used, 1);
});

test('identity: a credit-funded job takes the quota lock exactly once (the roll), never the bump', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: 0 });
  const r = await post();
  assert.equal(r.status, 201, `expected a 201, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(quotaLocks(), [USER], 'the roller runs; the bumper does not');
  assert.deepEqual(f().bumps, []);
});

// ---------------------------------------------------------------------------
// 6. The period must roll on EVERY authed upload, whatever funded it.
//
// This is Finding A. rate-limit.ts is the only period roller an account
// without an active subscription ever gets, and both quota gates read a
// jobs_used that only means anything inside the period it maintains — while
// sitting upstream of the tx that maintains it. So a credit-funded job that
// skipped the roll left a free account at quota with a period that had ended
// and no way to ever refresh it: refused forever, and told its allowance
// "resets at the start of next month" after next month had arrived.
// ---------------------------------------------------------------------------
test('stale period: a credit-funded job rolls the period forward and spends no allowance unit', async () => {
  seed({ plan: 'free', credits: 1, jobsUsed: 5, periodStart: STALE_START, periodEnd: STALE_END });
  const r = await post();
  assert.equal(r.status, 201, `expected a 201, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(f().rolls, [USER], 'the credit path must still roll the period');
  assert.equal(f().ents[USER].period_end, CUR_END, 'period rolled to the current month');
  assert.equal(f().ents[USER].jobs_used, 0, 'rolled to a fresh period, and the credit paid for the job');
  assert.deepEqual(f().consumption.map((c) => c.user_id), [USER]);
  assert.deepEqual(f().bumps, [], 'the roller is not the bumper');
});

test('stale period: credits then the fresh allowance — no permanent lockout', async () => {
  // Month 1: allowance of 5 fully spent, then that period ended. The user
  // bought 1 credit and spends it now, in a later month. The allowance for
  // THIS month has never been touched, so it must serve the next 5 jobs.
  seed({ plan: 'free', credits: 1, jobsUsed: 5, periodStart: STALE_START, periodEnd: STALE_END });
  const r = await run(7);
  assert.deepEqual(r.map((x) => x.status), [201, 201, 201, 201, 201, 201, 402],
    `statuses ${JSON.stringify(r.map((x) => x.status))}; ` +
    `jobs_used=${f().ents[USER]?.jobs_used} period_end=${f().ents[USER]?.period_end}`);
  assert.equal(r[6].body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 5, jobs: 6 });
});

test('stale period, no credits: the FIRST gate does not refuse on an expired period', async () => {
  // enforceEntitlement() runs before checkMonthlyQuota() and used to lack the
  // stale-period escape checkMonthlyQuota() has. With jobs_used at quota and
  // the period over, it threw FREE_MONTHLY_QUOTA_EXHAUSTED at the door — and
  // the only writer that could have refreshed the counter sits behind it.
  seed({ plan: 'free', credits: 0, jobsUsed: 5, periodStart: STALE_START, periodEnd: STALE_END });
  const r = await post();
  assert.equal(r.status, 201, `expected a 201, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(f().rolls, [USER]);
  assert.equal(f().ents[USER].jobs_used, 1, 'roll to 0, then this job meters 1');
  assert.equal(f().ents[USER].period_end, CUR_END);
});

test('stale period, quota-funded: roll then meter lands on exactly 1', async () => {
  // Composition check. A roller that forgets to reset leaves 6; a roller that
  // meters as well leaves 2; a bumper that does not bump leaves 0.
  seed({ plan: 'free', credits: 0, jobsUsed: 5, periodStart: STALE_START, periodEnd: STALE_END });
  const [a] = await run(1);
  assert.equal(a.status, 201);
  assert.equal(f().ents[USER].jobs_used, 1);
  const [b] = await run(1);
  assert.equal(b.status, 201);
  assert.equal(f().ents[USER].jobs_used, 2, 'the second job meters against the rolled period');
  assert.deepEqual(f().rolls, [USER], 'the period is rolled once, not once per job');
});

// ---------------------------------------------------------------------------
// 7. The staleness predicate itself, shared by both gates.
// ---------------------------------------------------------------------------
test('isPeriodStale: only a parseable period_end in the past is stale', () => {
  const now = Date.parse('2026-11-12T00:00:00Z');
  assert.equal(ent.isPeriodStale(null, now), false, 'no row / degraded read is not stale');
  assert.equal(ent.isPeriodStale('not a date', now), false, 'unparseable is not stale');
  assert.equal(ent.isPeriodStale('2026-10-01T00:00:00Z', now), true);
  assert.equal(ent.isPeriodStale('2026-12-01T00:00:00Z', now), false);
  assert.equal(ent.isPeriodStale('2026-11-12T00:00:00Z', now), true, 'period_end <= now, as in the SQL');
});
