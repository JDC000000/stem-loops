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
  | 'export_stems'        // export full stems .zip (pro+)
  | 'export_wav24';       // export 24-bit WAV (studio only)

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

async function readSnapshot(userId: string): Promise<EntitlementSnapshot> {
  const [entRes, balRes, trialRes] = await Promise.all([
    db.query<EntitlementRow>(
      `SELECT plan_code, period_start, period_end, jobs_used
         FROM entitlements WHERE user_id = $1`,
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
  const planCode = entRow?.plan_code ?? 'free';

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
  const credits_remaining =
    typeof credits === 'number'
      ? credits
      : typeof credits === 'string'
        ? Number.parseInt(credits, 10) || 0
        : 0;

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
      // Free / no-plan: needs at least one credit.
      if (snap.credits_remaining > 0) return { allowed: true, snapshot: snap };
      throw new EntitlementError('CREDIT_BALANCE_INSUFFICIENT');
    }
    case 'export_stems': {
      if (snap.export.stems) return { allowed: true, snapshot: snap };
      throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'stems export not in plan');
    }
    case 'export_wav24': {
      if (snap.export.wav24) return { allowed: true, snapshot: snap };
      throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', 'wav24 export not in plan');
    }
    default: {
      // Exhaustiveness guard; if a new action lands, TS forces an update here.
      const _never: never = action;
      throw new EntitlementError('ENTITLEMENT_UNAVAILABLE', `unknown action ${_never}`);
    }
  }
}
