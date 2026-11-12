// Rate limits — V3 Phase 1a, V3-C4 (TSD §1.4).
//
// Two independent limits apply to authenticated job creation:
//
//   (A) Monthly quota: a user may not create more than
//       entitlements.jobs_used >= plans.monthly_job_quota per period.
//       Plans with monthly_job_quota >= UNLIMITED_SENTINEL (100000) are
//       treated as unlimited — Pro/Studio (TSD §1.3). 402 on hit.
//
//   (B) Burst: at most 3 job starts per 60 seconds per authed user,
//       mirrored on the billing/checkout rate-limit pattern (usage_events
//       kind='job_start_attempt' + per-user advisory lock). 429 on hit.
//
// Free-tier (anonymous) jobs continue to use the per-IP admission gate in
// /api/uploads — this file does nothing for requests without user_id.
//
// The quota counter must stay in step with the real jobs insert, so
// bumpJobsUsed() runs inside the same tx as the INSERT INTO jobs,
// guarded by a per-(user,period) advisory lock. Advisory locks taken
// with pg_advisory_xact_lock release automatically at COMMIT/ROLLBACK.
//
// TWO CONCERNS, TWO FUNCTIONS (adversarial review of #233, Finding A). The
// old incrementJobsUsed() did two unrelated jobs in one UPSERT: it rolled
// period_start/period_end forward when they were stale, and it metered one
// unit of the monthly allowance. That was invisible until a caller needed one
// without the other. A credit-funded upload must NOT spend an allowance unit
// — but it must still roll a stale period, because this file is the only
// place in the repo that ever rolls it, and every quota gate sits upstream of
// it. Gating the whole UPSERT on "is this quota-funded?" therefore traded a
// double debit for a permanent lockout. So:
//
//   rollPeriodIfStale()  period bookkeeping only — call on EVERY authed job,
//                        whatever funded it.
//   bumpJobsUsed()       metering only — call only when the job is funded by
//                        the monthly allowance.

import { db } from '@/lib/db';
import { getEntitlementSnapshot, isPeriodStale } from './entitlements';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Burst window (B): 3 starts / 60 s. */
export const BURST_WINDOW_MS = 60_000;
export const BURST_LIMIT_PER_USER = 3;

/** Postgres advisory-lock namespace tags. Short strings hashed via
 *  hashtext() give a stable 32-bit key, safely partitioned from any
 *  other advisory-lock caller in the app. */
const BURST_LOCK_TAG = 'job_burst';
const QUOTA_LOCK_TAG = 'job_quota';

/** Plans with monthly_job_quota >= this sentinel are treated as unlimited.
 *  Must match 014_v3_seed_plans.sql (Pro=100000, Studio=100000). */
export const UNLIMITED_QUOTA_SENTINEL = 100_000;

// ---------------------------------------------------------------------------
// Public result shape consumed by the jobs route
// ---------------------------------------------------------------------------

export type QuotaDenial = {
  kind: 'quota_exceeded';
  /** When the user's current period rolls over. ISO8601. */
  resets_at: string;
};

export type BurstDenial = {
  kind: 'rate_limit_burst';
  /** Seconds the client should wait before retrying. */
  retry_after_s: number;
};

// ---------------------------------------------------------------------------
// (B) Burst limit — 3 starts / 60 s per authed user.
//
// Mirrors apps/web/src/app/api/billing/checkout/route.ts underCheckoutRateLimit:
//   tx { advisory-lock on (tag, user_id); COUNT in window; INSERT usage_event }.
// ---------------------------------------------------------------------------

/** Returns null when under the burst limit (and records the attempt),
 *  or a BurstDenial carrying retry_after_s when the limit is hit. */
export async function checkBurstLimit(userId: string): Promise<BurstDenial | null> {
  return db.tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2::text))`,
      [BURST_LOCK_TAG, userId],
    );
    const countRes = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM usage_events
        WHERE user_id = $1::uuid
          AND kind = 'job_start_attempt'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
      [userId, BURST_WINDOW_MS],
    );
    const n = Number.parseInt(countRes.rows[0]?.n ?? '0', 10);
    if (n >= BURST_LIMIT_PER_USER) {
      return { kind: 'rate_limit_burst', retry_after_s: 60 } as BurstDenial;
    }
    await client.query(
      `INSERT INTO usage_events (user_id, kind, detail)
       VALUES ($1::uuid, 'job_start_attempt', '{}'::jsonb)`,
      [userId],
    );
    return null;
  });
}

// ---------------------------------------------------------------------------
// (A) Monthly quota — jobs_used vs plans.monthly_job_quota.
// ---------------------------------------------------------------------------

/** Returns null when under quota (or plan is unlimited), or a QuotaDenial
 *  carrying resets_at when jobs_used >= monthly_job_quota.
 *
 *  Uses the entitlement snapshot's 30-second cache. That is a soft overcount
 *  risk — up to ~30 s of concurrent bursts can read a stale jobs_used — but
 *  the subsequent per-(user, period) advisory lock + UPSERT in
 *  bumpJobsUsed() is the hard boundary; this check is the cheap 402
 *  short-circuit that avoids reaching the DB on the hot path. */
export async function checkMonthlyQuota(userId: string): Promise<QuotaDenial | null> {
  const snap = await getEntitlementSnapshot(userId);
  // Pro / Studio sentinel: do not gate.
  if (snap.jobs_quota >= UNLIMITED_QUOTA_SENTINEL) return null;
  // Credit-holders (review M1): a free-plan user who bought credits keeps
  // entitlements.plan_code = 'free', so the free 90-jobs/mo quota would block
  // jobs they have already paid for. Their spend is metered by the credit
  // consume path (credits.ts), so skip the monthly quota while credits remain.
  if (snap.plan_code === 'free' && snap.credits_remaining > 0) return null;
  // Period rollover (PR #33 round-2 fix #3): if the current wall-clock time is
  // past the user's period_end, the stored jobs_used belongs to a stale period
  // and the gate should allow — rollPeriodIfStale() resets the counter and
  // rolls period_start/period_end forward in the same tx as the jobs INSERT.
  // Shared predicate: enforceEntitlement()'s free branch calls the same
  // function, so the two gates cannot disagree about staleness again.
  if (isPeriodStale(snap.period_end)) return null;
  if (snap.jobs_used < snap.jobs_quota) return null;
  // period_end can be null in degraded reads; return an empty string rather
  // than crash — caller surfaces resets_at verbatim in the 402 body.
  return { kind: 'quota_exceeded', resets_at: snap.period_end ?? '' };
}

// ---------------------------------------------------------------------------
// Period roll + atomic counter bump — both run inside the jobs-insert tx.
// ---------------------------------------------------------------------------

/** The client shape both writers need: anything with a pg-style .query(). */
type QuotaTxClient = {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
};

/** Per-(user, period_start) advisory lock.
 *
 *  Keeps two concurrent inserts from reading the same jobs_used and both
 *  writing jobs_used+1 (double-count). Scope is (user, period) so a period
 *  rollover does not block. period_start is read via a subselect; when the
 *  row does not exist yet the COALESCE collapses to '' and the lock is still
 *  per-user. pg_advisory_xact_lock releases at COMMIT/ROLLBACK.
 *
 *  Both writers below take it, so when a quota-funded job calls both, the
 *  roller takes the key for the OLD period and the bumper the key for the NEW
 *  one. That is intentional: a concurrent tx blocked on the old key sees the
 *  rolled row when it is released, finds nothing to roll, and then serialises
 *  against the bumper on the new key. Acquisition order is always
 *  roll-then-bump, so there is no lock-ordering cycle. */
async function takeQuotaLock(client: QuotaTxClient, userId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext(
       $1 || ':' || $2::text || ':' ||
       COALESCE((SELECT period_start::text FROM entitlements WHERE user_id = $2::uuid), '')
     ))`,
    [QUOTA_LOCK_TAG, userId],
  );
}

/** Roll period_start/period_end forward when the stored period has ended, and
 *  reset the allowance counter to 0 for the new period.
 *
 *  CALL THIS ON EVERY AUTHED JOB, WHATEVER FUNDED IT. It is the only period
 *  roller in the repo for an account with no active subscription (the billing
 *  webhook's upsertEntitlementFromSubscription() returns early unless the
 *  subscription is active/trialing, and a free user who merely bought credits
 *  only ever writes credit_purchases). Every quota gate reads a counter that
 *  is only meaningful inside the period this function maintains, and every
 *  gate runs upstream of it — so a job that skips the roll leaves the account
 *  one step closer to a refusal that cannot clear itself.
 *
 *  Metering is deliberately NOT here: jobs_used lands on 0, not 1. A
 *  quota-funded job calls bumpJobsUsed() straight after and ends on 1, which
 *  is byte-for-byte the state the old single UPSERT produced.
 *
 *  Conditional UPDATE, not an UPSERT, on purpose: a user with no entitlements
 *  row has no period to roll (period_end is NULL, jobs_used reads as 0, no
 *  gate can refuse them), and a credit-funded job must not bring a quota
 *  counter into existence. 0 rows updated is the normal, correct outcome. */
export async function rollPeriodIfStale(
  client: QuotaTxClient,
  userId: string,
): Promise<void> {
  await takeQuotaLock(client, userId);
  await client.query(
    `UPDATE entitlements
        SET jobs_used    = 0,
            period_start = date_trunc('month', now()),
            period_end   = date_trunc('month', now()) + interval '1 month'
      WHERE user_id = $1::uuid
        AND period_end <= now()`,
    [userId],
  );
}

/** Spend one unit of the monthly allowance.
 *
 *  CALL THIS ONLY WHEN THE MONTHLY ALLOWANCE IS WHAT FUNDS THE JOB. A
 *  credit-funded job is metered by the credit ledger (credits.ts) and must not
 *  also come through here — that was the double debit this PR removes.
 *
 *  Three outcomes handled atomically inside the caller's tx:
 *    (a) Entitlement row missing (signup trigger has not fired yet, or the
 *        user was created before the trigger shipped): INSERT a fresh 'free'
 *        row with the current month as the period and jobs_used = 1. The
 *        alternative — silently no-op on UPDATE … WHERE user_id = $1 —
 *        bypasses the quota gate and is a correctness bug (PR #33 round-2
 *        review fix #2).
 *    (b) Entitlement row present, period still current: bump jobs_used by 1.
 *    (c) Entitlement row present, period stale (NOW() > period_end): reset
 *        jobs_used to 1 and roll the period forward. rollPeriodIfStale() has
 *        normally already done this a statement earlier, so these CASE arms
 *        are belt-and-braces — kept so that bumpJobsUsed() remains correct on
 *        its own for the callers that do not pair it with the roller (the
 *        link-ingest branches of /api/jobs).
 *
 *  Unlimited plans: we still count for analytics, but the gate in
 *  checkMonthlyQuota short-circuits via UNLIMITED_QUOTA_SENTINEL.
 *
 *  Must be called on the SAME transaction as the INSERT INTO jobs so a
 *  rollback of the insert also rolls back the count. */
export async function bumpJobsUsed(
  client: QuotaTxClient,
  userId: string,
): Promise<void> {
  await takeQuotaLock(client, userId);
  // UPSERT handles all three cases in one statement:
  //   - ON CONFLICT DO UPDATE always fires because user_id is PRIMARY KEY.
  //   - When the row is new, the VALUES clause seeds it with 'free',
  //     period = [this month, next month), jobs_used = 1.
  //   - When the row exists and NOW() > period_end, the UPDATE clause
  //     resets jobs_used to 1 and rolls the period forward.
  //   - Otherwise the UPDATE clause bumps jobs_used by 1 and leaves the
  //     period alone.
  await client.query(
    `INSERT INTO entitlements (user_id, plan_code, period_start, period_end, jobs_used)
     VALUES (
       $1::uuid,
       'free',
       date_trunc('month', now()),
       date_trunc('month', now()) + interval '1 month',
       1
     )
     ON CONFLICT (user_id) DO UPDATE SET
       jobs_used = CASE
         WHEN entitlements.period_end <= now() THEN 1
         ELSE entitlements.jobs_used + 1
       END,
       period_start = CASE
         WHEN entitlements.period_end <= now() THEN date_trunc('month', now())
         ELSE entitlements.period_start
       END,
       period_end = CASE
         WHEN entitlements.period_end <= now()
           THEN date_trunc('month', now()) + interval '1 month'
         ELSE entitlements.period_end
       END`,
    [userId],
  );
}
