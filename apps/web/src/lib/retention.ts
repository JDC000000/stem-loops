// Retention policy (Jon, 2026-11-15):
//   * Free (and every job started without an account): deleted 24 hours after creation.
//     jobs.expires_at = created_at + 24h (migration 007); RETENTION_* below.
//   * Pro and Studio: kept while the subscription is effective, plus 30 days' grace after
//     it stops being effective, then deleted the normal way. Users build a library.
// Enforced by the worker's retention sweep (apps/worker/src/worker/cleanup.py) using the
// SAME SQL expression as JOB_RETAINED_UNTIL_SQL below (pinned identical by
// apps/worker/tests/test_paid_retention.py). Keep these in sync with those.
// Erasable-syntax only (no enums/param-properties) so node's type-stripping can run its test.

/** Free's retention window. Exact, and promised on /privacy, /terms and /pricing. */
export const RETENTION_HOURS = 24;
export const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;
export const RETENTION_SEC = RETENTION_MS / 1000;

/** Days a Pro/Studio library is kept after the plan stops being effective. */
export const PAID_RETENTION_GRACE_DAYS = 30;

/**
 * When a job's retention REALLY ends: `jobs.expires_at` (24 h), pushed later by the owner's
 * Pro/Studio subscription. A SQL scalar over the `jobs` row in scope (the query must read
 * `FROM jobs`, unaliased). Every job route gates on `${JOB_RETAINED_UNTIL_SQL} > now()` and
 * returns it AS expires_at, so a page's countdown, the loops window and the signed-URL TTLs
 * all follow the same deadline the worker's sweep deletes on.
 *
 * paid_until per subscription (same semantics as effectivePlanCode in billing/entitlements.ts):
 *   active / trialing -> current_period_end; past_due -> current_period_start + 7 days
 *   (PAST_DUE_GRACE_MS); canceled / paused -> LEAST(current_period_end, updated_at), when it
 *   stopped; incomplete -> nothing. Then + 30 days. It applies only to an owned job created
 *   on or before paid_until (a job made after the plan ended is a Free job: 24 h exactly),
 *   that was not killed by account deletion (expires_at <= created_at) and is not an
 *   anonymised shell. Computed at read time: no webhook or backfill has to run for it.
 *
 * DO NOT EDIT WITHOUT apps/worker/src/worker/cleanup.py RETAINED_UNTIL_SQL.
 */
export const JOB_RETAINED_UNTIL_SQL =
  "GREATEST(jobs.expires_at, (" +
  "SELECT MAX(p.paid_until) + interval '30 days' FROM (" +
  "SELECT CASE" +
  " WHEN s.status IN ('active','trialing') THEN s.current_period_end" +
  " WHEN s.status = 'past_due' THEN s.current_period_start + interval '7 days'" +
  " WHEN s.status IN ('canceled','paused') THEN LEAST(s.current_period_end, s.updated_at)" +
  " END AS paid_until" +
  " FROM public.subscriptions s" +
  " WHERE s.user_id = jobs.user_id AND s.plan_code IN ('pro','studio')" +
  ") p" +
  " WHERE p.paid_until >= jobs.created_at" +
  " AND jobs.expires_at > jobs.created_at" +
  " AND jobs.client_ip_hash <> 'purged'" +
  "))";

// Floor so a presign for a job seconds from expiry is still a valid positive TTL.
const MIN_PRESIGN_SEC = 60;

/**
 * Presigned-download TTL for a job: 24h, but never past the job's own expires_at — a URL
 * minted at hour 23 must not outlive the objects it points at. `expiresAt` is the
 * jobs.expires_at value (Date, ISO string, or null/invalid → full window, capped at 24h).
 */
export function presignTtlSec(expiresAt: Date | string | null | undefined, nowMs: number = Date.now()): number {
  if (expiresAt == null) return RETENTION_SEC;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return RETENTION_SEC;
  const remaining = Math.floor((t - nowMs) / 1000);
  return Math.min(RETENTION_SEC, Math.max(MIN_PRESIGN_SEC, remaining));
}

/** "in 12 days" (48 h or more) / "in 5 hours" / "in 12 minutes" / "in under a minute" / "expired". */
export function formatExpiresIn(expiresAtMs: number, nowMs: number = Date.now()): string {
  const ms = expiresAtMs - nowMs;
  if (ms <= 0) return 'expired';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'in under a minute';
  if (min < 60) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `in ${Math.floor(h / 24)} days`;
  return `in ${h} hour${h === 1 ? '' : 's'}`;
}
