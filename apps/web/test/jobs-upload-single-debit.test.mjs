// POST /api/jobs (upload) must debit ONE thing per job.
//
// The defect: inside the jobs-insert tx the route ran
//     if (chargeCredit) await consumeCreditInTx(...)   // spends a credit
//     await incrementJobsUsed(...)                     // ALSO spends a quota unit
// so a credit-funded job burned a credit AND a unit of the monthly allowance.
// checkMonthlyQuota() waives the quota check "while credits remain" (review M1),
// which hides it — until the credits run out and the user finds the allowance
// they never used already spent by the jobs the credits paid for.
//
// Instrument: this is NOT a stubbed-collaborator test. The real route.ts,
// entitlements.ts, rate-limit.ts and credits.ts all run; only the database is
// replaced, by a stateful fake that interprets the handful of statements those
// modules issue and rolls back on a throw. Assertions are on the LEDGER (credits,
// jobs_used, job rows), not on which functions were called. An unrecognised SQL
// statement throws, so the fake cannot silently drift from the code under test.
//
// Not covered by the fake: period rollover inside incrementJobsUsed (its CASE
// arm is not interpreted; every scenario is mid-period), and the real
// credit_decrement_check trigger / v_credit_balance view.
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
const PLANS = {
  free: { code: 'free', monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false },
  pro: { code: 'pro', monthly_job_quota: 50, services: [], export_stems: false, export_wav24: false },
  studio: { code: 'studio', monthly_job_quota: 150, services: [], export_stems: true, export_wav24: false },
};

// ---------------------------------------------------------------------------
// The fake database (shared via globalThis so every data: module sees it).
// ---------------------------------------------------------------------------
const dbStub = dataUrl(`
  const F = () => globalThis.__fake;
  const PLANS = ${JSON.stringify(PLANS)};
  const ok = (rows = []) => ({ rows, rowCount: rows.length });
  function handle(sql, params) {
    const f = F();
    f.sql.push(sql.replace(/\\s+/g, ' ').trim().slice(0, 60));
    const s = sql.replace(/\\s+/g, ' ').trim();
    if (/^INSERT INTO credit_consumption/.test(s)) {
      if (f.credits > 0) { f.credits -= 1; f.creditRows.push(params[1]); return { rows: [{ id: 'c' }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (/^INSERT INTO jobs/.test(s)) { f.jobs.push(params[0]); return { rows: [{ id: params[0] }], rowCount: 1 }; }
    if (/^INSERT INTO entitlements/.test(s)) {
      if (f.ent) f.ent.jobs_used += 1;
      else f.ent = { plan_code: 'free', jobs_used: 1, sub_status: null };
      return ok();
    }
    if (/pg_advisory_xact_lock/.test(s)) return ok([{}]);
    if (/FROM usage_events/.test(s)) return ok([{ n: '0' }]);
    if (/^INSERT INTO usage_events/.test(s)) return ok();
    if (/FROM entitlements e/.test(s)) {
      return f.ent ? ok([{ ...f.ent, period_start: '2026-11-01T00:00:00Z', period_end: '2099-01-01T00:00:00Z',
                           sub_period_start: '2026-11-01T00:00:00Z' }]) : ok();
    }
    if (/FROM v_credit_balance/.test(s)) return ok([{ credits_remaining: f.credits }]);
    if (/FROM trial_grants/.test(s)) return ok();
    if (/FROM plans/.test(s)) return ok(PLANS[params[0]] ? [PLANS[params[0]]] : []);
    throw new Error('fake db: unrecognised SQL: ' + s.slice(0, 120));
  }
  const client = { query: async (sql, params) => handle(sql, params) };
  export const db = {
    query: async (sql, params) => handle(sql, params),
    tx: async (fn) => {
      const f = F();
      const before = JSON.stringify({ ent: f.ent, credits: f.credits, jobs: f.jobs, creditRows: f.creditRows });
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
    export const RATE_WINDOW_MS = 60000; export const RATE_LIMIT = 5;`),
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
const post = async () => {
  const id = jobId();
  return route.POST({
    json: async () => ({ jobId: id, uploadKey: `${id}/_input.mp3`, loop_length_bars: 4 }),
    headers: new Map(),
  });
};

/** Seed the ledger. `jobsUsed: null` = no entitlements row yet. */
function seed({ plan = 'free', credits = 0, jobsUsed = 0, billing = false }) {
  globalThis.__fake = {
    ent: jobsUsed === null ? null : { plan_code: plan, jobs_used: jobsUsed, sub_status: plan === 'free' ? null : 'active' },
    credits, jobs: [], creditRows: [], sql: [],
  };
  if (billing) process.env.BILLING_ENFORCED = 'true';
  else delete process.env.BILLING_ENFORCED;
  ent._resetEntitlementCacheForTests(); // each request below is "30 s later"
}
const ledger = () => ({
  credits: globalThis.__fake.credits,
  jobs_used: globalThis.__fake.ent?.jobs_used ?? 0,
  jobs: globalThis.__fake.jobs.length,
});
async function run(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    ent._resetEntitlementCacheForTests();
    const r = await post();
    out.push({ status: r.status, body: await r.json() });
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
  assert.equal(globalThis.__fake.ent, null, 'a credit job must not seed a quota counter');
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

test('boundary: lost race for the last credit -> 402, nothing debited, no job row', async () => {
  // The snapshot (30 s cache) still says 1 credit; the ledger says 0.
  seed({ plan: 'free', credits: 1, jobsUsed: 0 });
  await ent.getEntitlementSnapshot(USER); // prime the cache with credits_remaining = 1
  globalThis.__fake.credits = 0; // another request took it
  const r = await post();
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error_code, 'CREDIT_BALANCE_INSUFFICIENT');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 0, jobs: 0 });
});

test('billing enforced, free, 0 credits: refused, nothing debited', async () => {
  seed({ plan: 'free', credits: 0, jobsUsed: 0, billing: true });
  const [r] = await run(1);
  assert.equal(r.status, 402);
  assert.equal(r.body.error_code, 'CREDIT_BALANCE_INSUFFICIENT');
  assert.deepEqual(ledger(), { credits: 0, jobs_used: 0, jobs: 0 });
});
