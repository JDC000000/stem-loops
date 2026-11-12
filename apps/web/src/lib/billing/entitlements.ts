// Entitlement guard — V3 Phase 1a (TSD §1.7).
//
// enforceEntitlement(action, user_id) is the server-side authorization
// boundary between a feature request and billing state. Reads live DB
// (entitlements + plans + v_credit_balance + trial_grants), consults a
// 30-second in-memory cache, and either returns {allowed:true} or throws
// an EntitlementError carrying the 402 code and an error_copy key.
//
// Cache (TSD §1.7):
//   • Keyed on user_id, 30-second TTL.
//   • Invalidated by invalidateEntitlement(user_id), called from the
//     Stripe webhook whenever the user's subscription / credit / trial
//     state could have changed (checkout.session.completed, invoice.paid,
//     customer.subscription.*).
//   • "Fail open to restrictive": on DB error we treat the user as the
//     anonymous free tier (no services, no exports, 3-song trial state
//     unknown) and let the caller decide — never silently grant access.

import { db } from '@/lib/db';

// ---------------------------------------------------------------------------
// Error type carried out through the API response as { error_code, message }.
// ---------------------------------------------------------------------------

export type EntitlementErrorCode =
  | 'ENTITLEMENT_UNAVAILABLE'
  | 'TRIAL_EXHAUSTED'
  | 'CREDIT_BALANCE_INSUFFICIENT'
  | 'FREE_MONTHLY_QUOTA_EXHAUSTED'
  | 'PAID_LINK_INGEST_DISALLOWED'
  | 'PLAN_NOT_FOUND';

export class EntitlementError extends Error {
  readonly code: EntitlementErrorCode;
  readonly status: number;
  readonly errorCopyKey: EntitlementErrorCode;

  constructor(code: EntitlementErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'EntitlementError';
    this.code = code;
    // 402 Payment Required — consistent across billing-gated denials; the
    // response body carries the specific error_code for copy lookup.
    // PAID_LINK_INGEST_DISALLOWED is a 400 per TSD §1.2a (not a payment problem).
    this.status = code === 'PAID_LINK_INGEST_DISALLOWED' ? 400 : 402;
    this.errorCopyKey = code;
  }
}

// ---------------------------------------------------------------------------
// Actions the caller can ask about. Each action maps to a plan predicate.
// ---------------------------------------------------------------------------

export type EntitlementAction =
  | 'start_job_youtube'   // service=youtube ingest (free tier only; §1.2a)
  | 'start_job_spotify'   // service=spotify ingest (free tier only)
  | 'start_job_soundcloud'// service=soundcloud ingest (free tier only)
  | 'start_job_upload'    // own-file upload (any tier; consumes credit on free + no-plan)
  // Both export actions are DENIED on every plan as of migration 034, which
  // sets plans.export_stems and plans.export_wav24 false across the catalog.
  // Neither action has a production caller — nothing in src/app or src/lib
  // asks for either — so this is a contract kept for when the features exist,
  // not a live gate. See the two cases below.
  | 'export_stems'        // full-stems .zip — NOT IMPLEMENTED, no route exists
  | 'export_wav24';       // 24-bit WAV as a PAID extra — not a differentiator;
                          // every tier already gets 24-bit WAV loops

// ---------------------------------------------------------------------------
// Shape returned when enforceEntitlement is permissive (allowed:true) and
// also returned by getEntitlementSnapshot() for the /api/entitlements route.
// ---------------------------------------------------------------------------

export type EntitlementSnapshot = {
  plan_code: string;
  period_start: string | null;
  period_end: string | null;
  jobs_used: number;
  jobs_quota: number;
  services: string[];
  export: { stems: boolean; wav24: boolean };
  credits_remaining: number;
  trial_songs_remaining: number | null;
};

export type EntitlementAllow = { allowed: true; snapshot: EntitlementSnapshot };

// ---------------------------------------------------------------------------
// Billing enforcement switch (TSD §1.3 / §1.7).
//
// While no payment provider is connected there is no way for anyone to buy a
// credit, so gating free uploads on `credits_remaining > 0` charges a currency
// that cannot be obtained — a signed-in free account can do nothing at all.
// With the switch OFF (the default), a free / no-plan upload falls back to the
// plan's own `monthly_job_quota` instead: still a hard, metered spend bound
// (Replicate bills per GPU-second), already seeded in plans, already counted by
// incrementJobsUsed(). TSD §1.7 already assumes this shape — "Upload jobs on
// the free tier are not affected (free plan always has >=0 upload jobs
// available)".
//
// Set BILLING_ENFORCED=true (one Fly secret / env var, no deploy of this file)
// the day Stripe goes live and the credit gate below returns exactly as it is
// today. Read at CALL time — never captured at module load — so the flag can be
// flipped without a rebuild and so tests can exercise both sides, same shape as
// `dailySpendCeilingUsd()` / `uploadRateLimit()` in lib/admission.ts.
export const billingEnforced = (): boolean => process.env.BILLING_ENFORCED === 'true';

/** Human-readable denial for a free account that has spent its monthly job
 *  allowance. Must stay equal to ERROR_COPY.FREE_MONTHLY_QUOTA_EXHAUSTED's
 *  headline + action (asserted in billing-free-upload-quota.test.mjs). */
export const FREE_QUOTA_EXHAUSTED_MESSAGE =
  "You've used all your free songs this month. Your allowance resets at the start of next month.";

// ---------------------------------------------------------------------------
// In-memory cache. 30-second TTL per TSD §1.7. Module-level Map; serverless
// cold-start empties it, which is fine — it's a cache, not source of truth.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;

type CacheEntry = { snapshot: EntitlementSnapshot; expires_at: number };
const _cache = new Map<string, CacheEntry>();

function cacheGet(userId: string, now: number): EntitlementSnapshot | null {
  const hit = _cache.get(userId);
  if (!hit) return null;
  if (hit.expires_at <= now) {
    _cache.delete(userId);
    return null;
  }
  return hit.snapshot;
}

function cacheSet(userId: string, snapshot: EntitlementSnapshot, now: number): void {
  _cache.set(userId, { snapshot, expires_at: now + CACHE_TTL_MS });
}

/** Drop cached entitlement for a user. Webhook calls this on any billing
 *  state change so the next enforceEntitlement()/getEntitlementSnapshot()
 *  reads fresh from the DB. */
export function invalidateEntitlement(userId: string): void {
  _cache.delete(userId);
}

/** Test-only: wipe the whole cache. */
export function _resetEntitlementCacheForTests(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// DB read. Combines entitlements + plans + v_credit_balance + trial_grants
// so callers get a single snapshot. One round-trip (Promise.all, three
// queries) keeps request latency bounded.
// ---------------------------------------------------------------------------

type EntitlementRow = {
  plan_code: string;
  period_start: string;
  period_end: string;
  jobs_used: number;
  /** Status / period start of the user's best subscription (LEFT JOIN; null
   *  when the user has no subscriptions row). */
  sub_status?: string | null;
  sub_period_start?: string | null;
};
type PlanRow = {
  code: string;
  monthly_job_quota: number;
  services: string[];
  export_stems: boolean;
  export_wav24: boolean;
};
type CreditBalanceRow = { credits_remaining: number | string };
type TrialGrantRow = { songs_used: number; expires_at: string };

/** past_due grace policy. A failed renewal leaves the subscription past_due
 *  while Stripe retries the card (Smart Retries run for up to ~3 weeks). We
 *  keep paid access for 7 days from the start of the failed period, then drop
 *  to free: long enough that a lapsed card / bank hiccup does not lock out a
 *  paying customer mid-dunning, short enough that a dead card does not mean
 *  Pro forever. Measured from subscriptions.current_period_start because the
 *  failed renewal is what rolled that forward, and it needs no new column.
 *  period_end is NOT used for past_due: Stripe has already rolled it a full
 *  period ahead by the time the renewal fails. */
export const PAST_DUE_GRACE_MS = 7 * 24 * 3600 * 1000;

/** Has the stored billing period already ended?
 *
 *  Load-bearing, and shared on purpose. `entitlements.jobs_used` is only
 *  meaningful WITHIN the period `period_start`/`period_end` describe, and the
 *  only code that rolls that period forward (rollPeriodIfStale / bumpJobsUsed
 *  in rate-limit.ts) runs inside the jobs-INSERT tx — i.e. DOWNSTREAM of every
 *  gate. So a gate that refuses on a `jobs_used` belonging to a period that is
 *  over refuses forever: nothing upstream of it can ever refresh the counter it
 *  is reading.
 *
 *  That deadlock was real. `checkMonthlyQuota()` had this escape and
 *  `enforceEntitlement()`'s free branch did not, and `enforceEntitlement()`
 *  runs first — so a free account that reached quota and then stopped bumping
 *  the counter (which is exactly what a credit-funded account does) was locked
 *  out permanently, and told its allowance "resets at the start of next month"
 *  when next month had already arrived (adversarial review of #233, Finding A).
 *  Exported and called by both gates so they cannot drift apart again.
 *
 *  A null or unparseable `period_end` is NOT stale: there is no period to be
 *  past (no entitlements row, or a degraded read), and `jobs_used` defaults to
 *  0 in that case anyway. This keeps the exact semantics the inline check in
 *  checkMonthlyQuota() had. */
export function isPeriodStale(periodEnd: string | null, now: number = Date.now()): boolean {
  if (periodEnd === null) return false;
  const end = Date.parse(periodEnd);
  return Number.isFinite(end) && end <= now;
}

/** Which plan the user is ENTITLED to right now, as opposed to what the
 *  entitlements row says. The row is only ever written upward by the webhook,
 *  so it is not trusted on its own:
 *    active / trialing -> row plan, only while now < period_end
 *    past_due          -> row plan, only inside PAST_DUE_GRACE_MS
 *    anything else (canceled, incomplete, paused, no subscription row)
 *                      -> 'free'
 *  Free rows pass through unchanged. */
export function effectivePlanCode(args: {
  planCode: string;
  periodEnd: string | null;
  subStatus: string | null | undefined;
  subPeriodStart: string | null | undefined;
  now: number;
}): string {
  const { planCode, periodEnd, subStatus, subPeriodStart, now } = args;
  if (planCode === 'free') return 'free';
  if (subStatus === 'active' || subStatus === 'trialing') {
    const end = periodEnd ? Date.parse(periodEnd) : NaN;
    return Number.isFinite(end) && end > now ? planCode : 'free';
  }
  if (subStatus === 'past_due') {
    const start = subPeriodStart ? Date.parse(subPeriodStart) : NaN;
    return Number.isFinite(start) && now < start + PAST_DUE_GRACE_MS ? planCode : 'free';
  }
  return 'free';
}

async function readSnapshot(userId: string): Promise<EntitlementSnapshot> {
  const [entRes, balRes, trialRes] = await Promise.all([
    db.query<EntitlementRow>(
      `SELECT e.plan_code, e.period_start, e.period_end, e.jobs_used,
              s.status AS sub_status, s.current_period_start AS sub_period_start
         FROM entitlements e
         LEFT JOIN LATERAL (
           SELECT status, current_period_start
             FROM subscriptions
            WHERE user_id = e.user_id
            ORDER BY (status IN ('active','trialing')) DESC,
                     (status = 'past_due') DESC,
                     current_period_end DESC
            LIMIT 1
         ) s ON true
        WHERE e.user_id = $1`,
      [userId],
    ),
    db.query<CreditBalanceRow>(
      `SELECT credits_remaining FROM v_credit_balance WHERE user_id = $1`,
      [userId],
    ),
    db.query<TrialGrantRow>(
      `SELECT songs_used, expires_at FROM trial_grants WHERE user_id = $1`,
      [userId],
    ),
  ]);

  const entRow = entRes.rows[0];
  // Never trust entitlements.plan_code alone: gate on period_end and the
  // subscription status (see effectivePlanCode).
  const planCode = entRow
    ? effectivePlanCode({
        planCode: entRow.plan_code,
        periodEnd: entRow.period_end,
        subStatus: entRow.sub_status,
        subPeriodStart: entRow.sub_period_start,
        now: Date.now(),
      })
    : 'free';

  const planRes = await db.query<PlanRow>(
    `SELECT code, monthly_job_quota, services, export_stems, export_wav24
       FROM plans WHERE code = $1`,
    [planCode],
  );
  const plan = planRes.rows[0];
  if (!plan) {
    throw new EntitlementError('PLAN_NOT_FOUND', `plan ${planCode} missing from plans table`);
  }

  const credits = balRes.rows[0]?.credits_remaining;
  // Defensive clamp (review M6): never surface a negative balance even if
  // migration 022's GREATEST(0, ...) has not been applied yet.
  const credits_remaining = Math.max(
    0,
    typeof credits === 'number'
      ? credits
      : typeof credits === 'string'
        ? Number.parseInt(credits, 10) || 0
        : 0,
  );

  let trial_songs_remaining: number | null = null;
  const trialRow = trialRes.rows[0];
  if (trialRow && new Date(trialRow.expires_at).getTime() > Date.now()) {
    trial_songs_remaining = Math.max(0, 3 - trialRow.songs_used);
  }

  return {
    plan_code: plan.code,
    period_start: entRow?.period_start ?? null,
    period_end: entRow?.period_end ?? null,
    jobs_used: entRow?.jobs_used ?? 0,
    jobs_quota: plan.monthly_job_quota,
    services: plan.services ?? [],
    export: { stems: plan.export_stems, wav24: plan.export_wav24 },
    credits_remaining,
    trial_songs_remaining,
  };
}

/** Load a user's entitlement snapshot, honoring the 30-second cache.
 *  Throws EntitlementError('ENTITLEMENT_UNAVAILABLE') on DB failure. */
export async function getEntitlementSnapshot(userId: string): Promise<EntitlementSnapshot> {
  const now = Date.now();
  const cached = cacheGet(userId, now);
  if (cached) return cached;
  try {
    const snapshot = await readSnapshot(userId);
    cacheSet(userId, snapshot, now);
    return snapshot;
  } catch (err) {
    if (err instanceof EntitlementError) throw err;
    throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// enforceEntitlement — the single boundary feature routes call.
// ---------------------------------------------------------------------------

export async function enforceEntitlement(
  action: EntitlementAction,
  userId: string,
): Promise<EntitlementAllow> {
  const snap = await getEntitlementSnapshot(userId);

  switch (action) {
    case 'start_job_youtube':
    case 'start_job_spotify':
    case 'start_job_soundcloud': {
      const service = action.replace('start_job_', '');
      // §1.2a processor separation: Pro/Studio are upload-only products.
      if (snap.plan_code === 'pro' || snap.plan_code === 'studio') {
        throw new EntitlementError('PAID_LINK_INGEST_DISALLOWED');
      }
      // Link-ingest is free-tier only (§1.2a processor separation).
      if (snap.services.includes(service)) return { allowed: true, snapshot: snap };
      // Not in the plan's services — if the user has an active trial, allow.
      if (snap.trial_songs_remaining !== null && snap.trial_songs_remaining > 0) {
        return { allowed: true, snapshot: snap };
      }
      if (snap.trial_songs_remaining === 0) {
        throw new EntitlementError('TRIAL_EXHAUSTED');
      }
      throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'service not in plan');
    }
    case 'start_job_upload': {
      // Upload: Pro/Studio = unlimited; Free = credit-based.
      if (snap.plan_code === 'pro' || snap.plan_code === 'studio') {
        if (snap.jobs_used < snap.jobs_quota) return { allowed: true, snapshot: snap };
        throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'quota exhausted');
      }
      // Free / no-plan: a credit always works, whichever side of the switch
      // we are on — a credit someone already holds is never stranded.
      if (snap.credits_remaining > 0) return { allowed: true, snapshot: snap };
      // Billing not enforced (no payment provider connected): fall back to the
      // plan's monthly job quota so the account is bounded but usable. The
      // counter this reads is the one incrementJobsUsed() writes in the jobs
      // INSERT tx, and checkMonthlyQuota() re-checks it on the same request.
      if (!billingEnforced()) {
        // Stale period: the same escape checkMonthlyQuota() has (rate-limit.ts).
        // Without it this gate refuses on a jobs_used that belongs to a period
        // which has ended, and because the period roller runs downstream of
        // here the refusal can never clear itself. See isPeriodStale().
        if (isPeriodStale(snap.period_end)) return { allowed: true, snapshot: snap };
        if (snap.jobs_used < snap.jobs_quota) return { allowed: true, snapshot: snap };
        // The message, not just the code: /api/jobs returns it verbatim and the
        // landing form renders `json.message`, so a bare code would reach the
        // user as the string FREE_MONTHLY_QUOTA_EXHAUSTED. Kept in step with
        // ERROR_COPY by a test rather than by importing it here.
        throw new EntitlementError('FREE_MONTHLY_QUOTA_EXHAUSTED', FREE_QUOTA_EXHAUSTED_MESSAGE);
      }
      throw new EntitlementError('CREDIT_BALANCE_INSUFFICIENT');
    }
    // Still data-driven — the flag is read, not hardcoded — so these cases
    // start allowing the moment a plan row sets the flag and a route exists to
    // honour it. Migration 034 sets both flags false on all three plans, so
    // today both always deny. The deny reasons say WHY, because "not in plan"
    // read as a plan-configuration problem when the real cause is that the
    // capability was never built.
    case 'export_stems': {
      if (snap.export.stems) return { allowed: true, snapshot: snap };
      throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'stems export not built: no stem-export route exists');
    }
    case 'export_wav24': {
      if (snap.export.wav24) return { allowed: true, snapshot: snap };
      throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'wav24 is not a paid gate: every plan gets 24-bit WAV loops');
    }
    default: {
      // Exhaustiveness guard; if a new action lands, TS forces an update here.
      const _never: never = action;
      throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', `unknown action ${_never}`);
    }
  }
}
