// Free-plan uploads fall back to the monthly job quota while billing is off.
// TSD §1.3 (entitlement checks) + §1.7 ("Upload jobs on the free tier are not
// affected — free plan always has >=0 upload jobs available").
//
// The defect this pins: with no payment provider connected, nobody can buy a
// credit, so `credits_remaining > 0` was a gate on a currency that cannot be
// obtained. A signed-in free account with 0 credits got 402
// CREDIT_BALANCE_INSUFFICIENT on every upload — the only working path was
// signing OUT. Link ingest is separately paused, so the account could do
// nothing at all.
//
// What is asserted here:
//   (1) switch OFF (default): free + 0 credits + under quota  -> allowed
//   (2) switch OFF:           free + 0 credits + quota spent  -> 402
//       FREE_MONTHLY_QUOTA_EXHAUSTED, NOT CREDIT_BALANCE_INSUFFICIENT
//   (3) switch ON:  every outcome is value-identical to the pre-change gate,
//       proved against an oracle that reimplements the old predicate, over a
//       cross-product of snapshots — not by matching source text.
//   (4) Pro / Studio are untouched on BOTH sides of the switch.
//   (5) At the route: a free 0-credit upload returns 201, charges NO credit,
//       and still bumps jobs_used — the bound is only a bound if it counts.
//
// No DB, no Next, no network: the TS is transpiled in memory and its imports
// are rewritten to data: URLs, same pattern as billing-entitlements-cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE, sameOriginHeaders } from './helpers/same-origin.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '../..');
const ENT_SRC = join(WEB, 'src/lib/billing/entitlements.ts');
const ROUTE_SRC = join(WEB, 'src/app/api/jobs/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const USER = '11111111-1111-1111-1111-111111111111';
const JOB_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// entitlements.ts under a stub DB that serves exactly one snapshot.
// readSnapshot order: Promise.all([entitlements, v_credit_balance,
// trial_grants]) then plans.
// ---------------------------------------------------------------------------

function entRows({ planCode, jobsUsed, jobsQuota, credits, services = [] }) {
  return [
    {
      rows: [
        {
          plan_code: planCode,
          period_start: '2026-11-01T00:00:00Z',
          period_end: '2099-01-01T00:00:00Z',
          jobs_used: jobsUsed,
          sub_status: planCode === 'free' ? null : 'active',
          sub_period_start: '2026-11-01T00:00:00Z',
        },
      ],
    },
    { rows: [{ credits_remaining: credits }] },
    { rows: [] },
    {
      rows: [
        {
          code: planCode,
          monthly_job_quota: jobsQuota,
          services,
          export_stems: planCode !== 'free',
          export_wav24: planCode === 'studio',
        },
      ],
    },
  ];
}

// A stub module's data: URL is its cache key, so two loads with identical
// fixtures would otherwise share ONE stub instance — and the second would find
// `rowsByOrder` already drained by the first. The nonce keeps them distinct.
let _stubSeq = 0;

async function loadEntitlements(rowsByOrder) {
  const js = toJs(readFileSync(ENT_SRC, 'utf8'));
  const stub = dataUrl(`
    // stub #${++_stubSeq}
    const rowsByOrder = ${JSON.stringify(rowsByOrder)};
    export const db = {
      query: async () => {
        const bucket = rowsByOrder.shift() || { rows: [] };
        return { rows: bucket.rows, rowCount: bucket.rows.length };
      },
      tx: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
    };
  `);
  const rewritten = js.replace(/from ['"]@\/lib\/db['"]/g, `from '${stub}'`);
  return import(dataUrl(rewritten) + '#' + Math.random());
}

/** Run enforceEntitlement('start_job_upload') once against a fresh module and
 *  reduce the result to a comparable plain value. */
async function uploadOutcome(fixture, { enforced }) {
  const prev = process.env.BILLING_ENFORCED;
  if (enforced) process.env.BILLING_ENFORCED = 'true';
  else delete process.env.BILLING_ENFORCED;
  try {
    const mod = await loadEntitlements(entRows(fixture));
    mod._resetEntitlementCacheForTests();
    try {
      const ok = await mod.enforceEntitlement('start_job_upload', USER);
      return { kind: 'allow', allowed: ok.allowed, snapshot: ok.snapshot };
    } catch (err) {
      return {
        kind: 'throw',
        name: err.name,
        code: err.code,
        status: err.status,
        message: err.message,
        errorCopyKey: err.errorCopyKey,
        isEntitlementError: err instanceof mod.EntitlementError,
      };
    }
  } finally {
    if (prev === undefined) delete process.env.BILLING_ENFORCED;
    else process.env.BILLING_ENFORCED = prev;
  }
}

/** The pre-change predicate, transcribed from origin/v3/main
 *  entitlements.ts case 'start_job_upload'. The oracle for claim (3). */
function legacyUploadOutcome(snap) {
  if (snap.plan_code === 'pro' || snap.plan_code === 'studio') {
    if (snap.jobs_used < snap.jobs_quota) return { kind: 'allow', allowed: true, snapshot: snap };
    return {
      kind: 'throw',
      name: 'EntitlementError',
      code: 'ENTITLEMENT_UNAVAILABLE',
      status: 402,
      message: 'quota exhausted',
      errorCopyKey: 'ENTITLEMENT_UNAVAILABLE',
      isEntitlementError: true,
    };
  }
  if (snap.credits_remaining > 0) return { kind: 'allow', allowed: true, snapshot: snap };
  return {
    kind: 'throw',
    name: 'EntitlementError',
    code: 'CREDIT_BALANCE_INSUFFICIENT',
    status: 402,
    message: 'CREDIT_BALANCE_INSUFFICIENT',
    errorCopyKey: 'CREDIT_BALANCE_INSUFFICIENT',
    isEntitlementError: true,
  };
}

// A cross-product wide enough that any behaviour change on the enforced side
// shows up: both quota sides, both credit sides, every plan.
const MATRIX = [];
for (const planCode of ['free', 'pro', 'studio']) {
  for (const credits of [0, 3]) {
    for (const [jobsUsed, jobsQuota] of [
      [0, 90],
      [89, 90],
      [90, 90],
      [91, 90],
    ]) {
      MATRIX.push({ planCode, credits, jobsUsed, jobsQuota });
    }
  }
}

// ---------------------------------------------------------------------------
// (1) + (2) — the switch OFF, which is the default.
// ---------------------------------------------------------------------------

test('switch OFF: free user with 0 credits CAN upload under the monthly quota', async () => {
  const fixture = { planCode: 'free', jobsUsed: 0, jobsQuota: 90, credits: 0 };
  const out = await uploadOutcome(fixture, { enforced: false });
  assert.equal(out.kind, 'allow', `expected allow, got ${out.code ?? out.kind}`);
  assert.equal(out.allowed, true);
  assert.equal(out.snapshot.plan_code, 'free');
  assert.equal(out.snapshot.credits_remaining, 0);
  // The allowance is the plan's own number, read from the snapshot — not a
  // literal spelled into this test.
  assert.ok(out.snapshot.jobs_used < out.snapshot.jobs_quota);
});

test('switch OFF: the last job inside the quota is still allowed', async () => {
  const out = await uploadOutcome(
    { planCode: 'free', jobsUsed: 89, jobsQuota: 90, credits: 0 },
    { enforced: false },
  );
  assert.equal(out.kind, 'allow');
  assert.equal(out.snapshot.jobs_used, out.snapshot.jobs_quota - 1);
});

test('switch OFF: free user at the quota is denied with FREE_MONTHLY_QUOTA_EXHAUSTED', async () => {
  for (const jobsUsed of [90, 91, 500]) {
    const out = await uploadOutcome(
      { planCode: 'free', jobsUsed, jobsQuota: 90, credits: 0 },
      { enforced: false },
    );
    assert.equal(out.kind, 'throw', `jobs_used=${jobsUsed} should be denied`);
    assert.equal(out.code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
    assert.equal(out.errorCopyKey, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
    assert.equal(out.status, 402);
    assert.equal(out.isEntitlementError, true);
    // The lie this replaces: with billing off, "out of credits" is not why.
    assert.notEqual(out.code, 'CREDIT_BALANCE_INSUFFICIENT');
    // /api/jobs returns `message` verbatim and the landing form renders it, so
    // it must be a sentence, never the bare code.
    assert.notEqual(out.message, out.code);
    assert.ok(/ /.test(out.message) && /[.!]$/.test(out.message), out.message);
  }
});

test('switch OFF: a credit a user already holds is still honoured, never stranded', async () => {
  // Over quota but holding credits -> allowed, because the credit branch runs
  // before the quota fallback.
  const out = await uploadOutcome(
    { planCode: 'free', jobsUsed: 999, jobsQuota: 90, credits: 2 },
    { enforced: false },
  );
  assert.equal(out.kind, 'allow');
  assert.equal(out.snapshot.credits_remaining, 2);
});

test('FREE_MONTHLY_QUOTA_EXHAUSTED has user-facing copy', async () => {
  const copy = await import(
    dataUrl(toJs(readFileSync(join(WEB, 'src/lib/error-copy.ts'), 'utf8'))) + '#' + Math.random()
  );
  const entry = copy.ERROR_COPY.FREE_MONTHLY_QUOTA_EXHAUSTED;
  assert.ok(entry, 'every thrown entitlement code must map to copy (TSD §1.3)');
  assert.ok(entry.headline.length > 0);
  assert.ok(entry.action.length > 0);
  // It must not read like a billing problem while billing is off.
  assert.ok(!/credit/i.test(entry.headline));

  // The thrown message and the copy map must say the same thing — the route
  // returns the message and the landing form renders it, while anything
  // keying off error_code reads the map.
  const mod = await loadEntitlements(
    entRows({ planCode: 'free', jobsUsed: 0, jobsQuota: 90, credits: 0 }),
  );
  assert.equal(mod.FREE_QUOTA_EXHAUSTED_MESSAGE, `${entry.headline} ${entry.action}`);
});

// ---------------------------------------------------------------------------
// (3) — the switch ON returns the old behaviour, proved against an oracle.
// ---------------------------------------------------------------------------

test('switch ON: every outcome equals the pre-change gate across the matrix', async () => {
  assert.equal(MATRIX.length, 24, 'matrix must cover plan x credits x quota');
  for (const fixture of MATRIX) {
    const actual = await uploadOutcome(fixture, { enforced: true });
    const snap = {
      plan_code: fixture.planCode,
      jobs_used: fixture.jobsUsed,
      jobs_quota: fixture.jobsQuota,
      credits_remaining: fixture.credits,
    };
    const expected = legacyUploadOutcome(snap);
    const label = JSON.stringify(fixture);
    assert.equal(actual.kind, expected.kind, `kind differs for ${label}`);
    if (expected.kind === 'allow') {
      assert.equal(actual.allowed, expected.allowed, `allowed differs for ${label}`);
      assert.equal(actual.snapshot.plan_code, snap.plan_code, `plan differs for ${label}`);
      assert.equal(actual.snapshot.jobs_used, snap.jobs_used, `jobs_used differs for ${label}`);
      assert.equal(actual.snapshot.jobs_quota, snap.jobs_quota, `jobs_quota differs for ${label}`);
      assert.equal(
        actual.snapshot.credits_remaining,
        snap.credits_remaining,
        `credits differ for ${label}`,
      );
    } else {
      assert.deepEqual(
        {
          name: actual.name,
          code: actual.code,
          status: actual.status,
          message: actual.message,
          errorCopyKey: actual.errorCopyKey,
          isEntitlementError: actual.isEntitlementError,
        },
        {
          name: expected.name,
          code: expected.code,
          status: expected.status,
          message: expected.message,
          errorCopyKey: expected.errorCopyKey,
          isEntitlementError: expected.isEntitlementError,
        },
        `denial differs for ${label}`,
      );
    }
  }
});

test('switch ON: free + 0 credits is denied with CREDIT_BALANCE_INSUFFICIENT, under quota or not', async () => {
  for (const jobsUsed of [0, 89]) {
    const out = await uploadOutcome(
      { planCode: 'free', jobsUsed, jobsQuota: 90, credits: 0 },
      { enforced: true },
    );
    assert.equal(out.kind, 'throw');
    assert.equal(out.code, 'CREDIT_BALANCE_INSUFFICIENT');
  }
});

test('only the literal string true arms the switch', async () => {
  for (const raw of ['1', 'TRUE', 'yes', '', 'false']) {
    process.env.BILLING_ENFORCED = raw;
    try {
      const mod = await loadEntitlements(
        entRows({ planCode: 'free', jobsUsed: 0, jobsQuota: 90, credits: 0 }),
      );
      mod._resetEntitlementCacheForTests();
      assert.equal(mod.billingEnforced(), false, `${JSON.stringify(raw)} must not arm the switch`);
      const ok = await mod.enforceEntitlement('start_job_upload', USER);
      assert.equal(ok.allowed, true);
    } finally {
      delete process.env.BILLING_ENFORCED;
    }
  }
  process.env.BILLING_ENFORCED = 'true';
  try {
    const mod = await loadEntitlements(
      entRows({ planCode: 'free', jobsUsed: 0, jobsQuota: 90, credits: 0 }),
    );
    assert.equal(mod.billingEnforced(), true);
  } finally {
    delete process.env.BILLING_ENFORCED;
  }
});

test('the switch is read at call time, not captured at module load', async () => {
  delete process.env.BILLING_ENFORCED;
  const mod = await loadEntitlements(
    entRows({ planCode: 'free', jobsUsed: 0, jobsQuota: 90, credits: 0 }),
  );
  assert.equal(mod.billingEnforced(), false);
  process.env.BILLING_ENFORCED = 'true';
  try {
    assert.equal(mod.billingEnforced(), true, 'the same module instance must see the new value');
  } finally {
    delete process.env.BILLING_ENFORCED;
  }
});

// ---------------------------------------------------------------------------
// (4) — Pro / Studio regression, both sides of the switch.
// ---------------------------------------------------------------------------

for (const planCode of ['pro', 'studio']) {
  for (const enforced of [false, true]) {
    test(`${planCode} upload is unchanged with the switch ${enforced ? 'ON' : 'OFF'}`, async () => {
      const under = await uploadOutcome(
        { planCode, jobsUsed: 7, jobsQuota: 100000, credits: 0 },
        { enforced },
      );
      assert.equal(under.kind, 'allow', `${planCode} under quota must be allowed`);
      assert.equal(under.snapshot.plan_code, planCode);

      const over = await uploadOutcome(
        { planCode, jobsUsed: 100000, jobsQuota: 100000, credits: 0 },
        { enforced },
      );
      assert.equal(over.kind, 'throw');
      // Paid plans keep the ENTITLEMENT_UNAVAILABLE denial, not the new code.
      assert.equal(over.code, 'ENTITLEMENT_UNAVAILABLE');
      assert.equal(over.message, 'quota exhausted');
      assert.notEqual(over.code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
      assert.notEqual(over.code, 'CREDIT_BALANCE_INSUFFICIENT');
    });
  }
}

// ---------------------------------------------------------------------------
// (5) — the route. The bound only bounds if the counter moves.
// ---------------------------------------------------------------------------

function routeStubs({ planCode, credits, quotaDenied = false }) {
  const cfg = JSON.stringify({ planCode, credits, quotaDenied });
  return {
    auth: dataUrl(
      `export const getUser = async () => ({ user_id: ${JSON.stringify(USER)}, email: 'u@x.co' });`,
    ),
    trial: dataUrl(`
      export const TRIAL_SONG_CAP = 3;
      export const consumeTrial = async () => ({ ok: true, songs_remaining: 2 });
      export const consumeTrialInTx = async () => ({ ok: true, songs_remaining: 2 });
    `),
    ent: dataUrl(`
      const cfg = ${cfg};
      globalThis.__q = globalThis.__q || [];
      export class EntitlementError extends Error {
        constructor(code, message) {
          super(message ?? code);
          this.name = 'EntitlementError';
          this.code = code;
          this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402;
          this.errorCopyKey = code;
        }
      }
      const snap = {
        plan_code: cfg.planCode,
        period_start: null, period_end: null,
        jobs_used: 0, jobs_quota: 90,
        services: [], export: { stems: false, wav24: false },
        credits_remaining: cfg.credits,
        trial_songs_remaining: null,
      };
      export const getEntitlementSnapshot = async () => snap;
      export const enforceEntitlement = async (action) => {
        globalThis.__q.push({ fn: 'enforceEntitlement', action });
        // Mirrors the real gate for the cases this file drives.
        if (cfg.planCode === 'free' && cfg.credits === 0 && billingEnforced()) {
          throw new EntitlementError('CREDIT_BALANCE_INSUFFICIENT');
        }
        return { allowed: true, snapshot: snap };
      };
      export const invalidateEntitlement = () => {};
      export const FREE_QUOTA_EXHAUSTED_MESSAGE = 'stub'; export const billingEnforced = () => process.env.BILLING_ENFORCED === 'true';
    `),
    credits: dataUrl(`
      globalThis.__q = globalThis.__q || [];
      export const consumeCreditInTx = async (_c, userId, jobId) => {
        globalThis.__q.push({ fn: 'consumeCredit', userId, jobId });
      };
    `),
    rate: dataUrl(`
      const cfg = ${cfg};
      globalThis.__q = globalThis.__q || [];
      export const checkBurstLimit = async () => null;
      export const checkMonthlyQuota = async () => {
        globalThis.__q.push({ fn: 'checkMonthlyQuota' });
        return cfg.quotaDenied ? { kind: 'quota_exceeded', resets_at: '2099-01-01T00:00:00Z' } : null;
      };
      // Both bumpers record as 'incrementJobsUsed' (so every "a refused job must not be
      // counted" assertion covers both); \`capped\` says which one ran (F2).
      export const bumpJobsUsedWithinQuota = async (_c, userId, quota) => {
        globalThis.__q.push({ fn: 'incrementJobsUsed', userId, capped: true, quota });
        return true;
      };
      export const bumpJobsUsed = async (_c, userId) => {
        globalThis.__q.push({ fn: 'incrementJobsUsed', userId, capped: false });
      };
      export const rollPeriodIfStale = async (_c, userId) => {
        globalThis.__q.push({ fn: 'rollPeriodIfStale', userId });
      };
      export const BURST_WINDOW_MS = 60000;
      export const BURST_LIMIT_PER_USER = 3;
      export const UNLIMITED_QUOTA_SENTINEL = 100000;
    `),
    admission: dataUrl(`
      export const checkAdmission = async () => ({ allowed: true, error_code: null });
      export const RATE_WINDOW_MS = 60000;
      export const RATE_LIMIT = 5;
      export const checkUploadRate = async () => ({ allowed: true, error_code: null });
    `),
    db: dataUrl(`
      globalThis.__q = globalThis.__q || [];
      export const db = {
        query: async (sql) => { globalThis.__q.push({ fn: 'db.query', sql }); return { rows: [{ id: 'r' }], rowCount: 1 }; },
        tx: async (fn) => fn({
          query: async (sql) => { globalThis.__q.push({ fn: 'db.tx.query', sql }); return { rows: [{ id: 'r' }], rowCount: 1 }; },
        }),
      };
    `),
    clientIp: dataUrl(`export const clientIpHashOf = () => 'hash';`),
    ytUrl: dataUrl(`
      export const canonicalizeYoutubeUrl = (u) => u;
      export const youtubeVideoId = () => 'vid';
    `),
    upload: dataUrl(`export const isValidUploadKey = () => true;`),
    sentry: dataUrl(`
      export const captureException = () => {};
      export const captureMessage = () => {};
      export const withScope = (fn) => fn({ setTag: () => {}, setContext: () => {} });
    `),
    next: dataUrl(`
      export class NextResponse {
        constructor(body, init) { this._b = body; this.status = (init && init.status) || 200; this.headers = new Map(); }
        static json(obj, init) {
          const r = new NextResponse(JSON.stringify(obj), init);
          r.body = obj;
          return r;
        }
        async json() { return this.body ?? JSON.parse(this._b); }
      }
      export class NextRequest {}
    `),
  };
}

async function loadRoute(opts) {
  globalThis.__q = [];
  const s = routeStubs(opts);
  let js = toJs(readFileSync(ROUTE_SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${s.auth}'`)
    .replace(/from ['"]@\/lib\/trial['"]/g, `from '${s.trial}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${s.ent}'`)
    .replace(/from ['"]@\/lib\/billing\/credits['"]/g, `from '${s.credits}'`)
    .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${s.rate}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${s.admission}'`)
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${dataUrl(toJs(readFileSync(join(WEB, 'src/lib/error-copy.ts'), 'utf8')))}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${s.db}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${s.clientIp}'`)
    .replace(/from ['"]@\/lib\/youtube-url['"]/g, `from '${s.ytUrl}'`)
    .replace(/from ['"]@\/lib\/upload['"]/g, `from '${s.upload}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${s.sentry}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${s.next}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const uploadReq = () => ({
  json: async () => ({ jobId: JOB_ID, uploadKey: `${JOB_ID}/_input.mp3`, loop_length_bars: 4 }),
  headers: sameOriginHeaders(),
});

test('route, switch OFF: free 0-credit upload returns 201, charges nothing, counts the job', async () => {
  delete process.env.BILLING_ENFORCED;
  const mod = await loadRoute({ planCode: 'free', credits: 0 });
  const res = await mod.POST(uploadReq());
  assert.equal(res.status, 201);
  const q = globalThis.__q;
  assert.ok(
    q.find((c) => c.fn === 'enforceEntitlement' && c.action === 'start_job_upload'),
    'the gate must still run',
  );
  assert.equal(q.find((c) => c.fn === 'consumeCredit'), undefined, 'no credit may be charged');
  const inc = q.filter((c) => c.fn === 'incrementJobsUsed');
  assert.equal(inc.length, 1, 'jobs_used must move exactly once — the bound is the counter');
  assert.equal(inc[0].userId, USER);
  // F2: a free, quota-funded upload must use the CAPPED bump, with the plan's quota as the cap.
  assert.equal(inc[0].capped, true, 'free allowance must be metered by bumpJobsUsedWithinQuota');
  assert.ok(inc[0].quota > 0, 'the cap passed must be the plan quota');
  // And it must happen inside the insert tx, after the jobs row.
  const insertIdx = q.findIndex((c) => c.fn === 'db.tx.query' && /INSERT INTO jobs/.test(c.sql));
  assert.ok(insertIdx >= 0, 'the job must be inserted in a tx');
  assert.ok(insertIdx < q.findIndex((c) => c.fn === 'incrementJobsUsed'));
});

test('route, switch OFF: free upload is refused once checkMonthlyQuota denies', async () => {
  delete process.env.BILLING_ENFORCED;
  const mod = await loadRoute({ planCode: 'free', credits: 0, quotaDenied: true });
  const res = await mod.POST(uploadReq());
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.code, 'quota_exceeded');
  assert.equal(
    globalThis.__q.find((c) => c.fn === 'incrementJobsUsed'),
    undefined,
    'a refused job must not be counted',
  );
});

test('route, switch ON: free 0-credit upload still 402s with CREDIT_BALANCE_INSUFFICIENT', async () => {
  process.env.BILLING_ENFORCED = 'true';
  try {
    const mod = await loadRoute({ planCode: 'free', credits: 0 });
    const res = await mod.POST(uploadReq());
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error_code, 'CREDIT_BALANCE_INSUFFICIENT');
    assert.equal(globalThis.__q.find((c) => c.fn === 'incrementJobsUsed'), undefined);
  } finally {
    delete process.env.BILLING_ENFORCED;
  }
});

test('route, switch OFF: a free user holding credits is still charged one', async () => {
  delete process.env.BILLING_ENFORCED;
  const mod = await loadRoute({ planCode: 'free', credits: 4 });
  const res = await mod.POST(uploadReq());
  assert.equal(res.status, 201);
  const charged = globalThis.__q.filter((c) => c.fn === 'consumeCredit');
  assert.equal(charged.length, 1, 'held credits are spent, not stranded');
});

for (const planCode of ['pro', 'studio']) {
  test(`route, switch OFF: ${planCode} upload 201s and charges no credit`, async () => {
    delete process.env.BILLING_ENFORCED;
    const mod = await loadRoute({ planCode, credits: 0 });
    const res = await mod.POST(uploadReq());
    assert.equal(res.status, 201);
    assert.equal(globalThis.__q.find((c) => c.fn === 'consumeCredit'), undefined);
    assert.equal(globalThis.__q.filter((c) => c.fn === 'incrementJobsUsed').length, 1);
    assert.equal(
      globalThis.__q.find((c) => c.fn === 'incrementJobsUsed').capped,
      false,
      'subscribers keep the ordinary metered bump (F2 is free-only)',
    );
  });
}

// ---------------------------------------------------------------------------
// The allowance the fallback leans on has to exist and be positive.
// ---------------------------------------------------------------------------

test("the seeded free plan carries a positive monthly_job_quota", () => {
  const sql = readFileSync(join(REPO, 'apps/worker/migrations/014_v3_seed_plans.sql'), 'utf8');
  const row = sql.match(/\(\s*'free'[^)]*?,\s*(\d+)\s*,\s*ARRAY\[/);
  assert.ok(row, "migration 014 must seed a 'free' plan row");
  const quota = Number.parseInt(row[1], 10);
  assert.ok(Number.isInteger(quota) && quota > 0, `free monthly_job_quota must be > 0, got ${quota}`);
  // And it must stay a real bound, not a stand-in for unlimited.
  assert.ok(quota < 100000, 'free must not be seeded at the unlimited sentinel');
});
