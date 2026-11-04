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
// incrementJobsUsed() runs inside the same tx as the INSERT INTO jobs,
// guarded by a per-(user,period) advisory lock. Advisory locks taken
// with pg_advisory_xact_lock release automatically at COMMIT/ROLLBACK.

import { db } from '@/lib/db';
import { getEntitlementSnapshot } from './entitlements';

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
 *  incrementJobsUsed() is the hard boundary; this check is the cheap 402
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
  // and the gate should allow — incrementJobsUsed() will reset the counter and
  // roll period_start/period_end forward in the same tx as the jobs INSERT.
  if (snap.period_end !== null && Date.parse(snap.period_end) <= Date.now()) {
    return null;
  }
  if (snap.jobs_used < snap.jobs_quota) return null;
  // period_end can be null in degraded reads; return an empty string rather
  // than crash — caller surfaces resets_at verbatim in the 402 body.
  return { kind: 'quota_exceeded', resets_at: snap.period_end ?? '' };
}

// ---------------------------------------------------------------------------
// Atomic counter bump — call this inside the jobs-insert tx.
// ---------------------------------------------------------------------------

/** Take the per-(user,period_start) advisory lock and bump jobs_used by 1.
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
 *        jobs_used to 1 and roll period_start/period_end forward to the
 *        current calendar month (PR #33 round-2 review fix #3).
 *
 *  Unlimited plans: we still count for analytics, but the gate in
 *  checkMonthlyQuota short-circuits via UNLIMITED_QUOTA_SENTINEL.
 *
 *  Must be called on the SAME transaction as the INSERT INTO jobs so a
 *  rollback of the insert also rolls back the count. */
export async function incrementJobsUsed(
  client: {
    query: <R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => Promise<{ rows: R[]; rowCount: number | null }>;
  },
  userId: string,
): Promise<void> {
  // Per-(user, period_start) advisory lock keeps two concurrent inserts
  // from reading the same jobs_used and both writing jobs_used+1 (double-
  // count). Scope is (user, period) so a period rollover does not block.
  // period_start is read via a subselect; when the row does not exist yet
  // (case a above) the COALESCE collapses to '' and the lock is still
  // per-user.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext(
       $1 || ':' || $2::text || ':' ||
       COALESCE((SELECT period_start::text FROM entitlements WHERE user_id = $2::uuid), '')
     ))`,
    [QUOTA_LOCK_TAG, userId],
  );
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
