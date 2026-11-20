// Server-side block on a second plan checkout (decision 1A, 2026-11-19).
//
// POST /api/billing/checkout with a plan_code opens a NEW Stripe subscription
// (Checkout mode 'subscription'). #301 stopped /pricing from OFFERING that to a
// viewer who already has a live subscription, but that is a display rule: a
// direct POST, a stale tab or a double click still opened a second subscription
// (Pro -> Studio double billing). Plan changes go through the provider's
// customer portal (Jon approved), so the server now refuses.
//
// Two checks, both only for plan checkouts (credit packs are one-time payments
// and are never blocked):
//
//   1. DB (primary). The subscriptions table, synced by the webhook: any row for
//      this user and provider in a LIVE status. Also a paid entitlements row with
//      NO subscriptions row at all: the webhook wrote the entitlement but the
//      subscription upsert has not landed (same rule as /pricing,
//      pricing-plan-state.ts). A user whose only rows are `canceled` may
//      resubscribe.
//   2. Provider (stale-sync fallback). The repo does not store checkout
//      sessions, so the window between a completed Checkout and its webhook is
//      invisible to the DB. The checkout route already calls Stripe, so when the
//      DB is clear and the user already has a stored provider customer, it asks
//      the provider for that customer's non-terminal subscriptions, with a short
//      bounded read (STRIPE_CHECKOUT_READ_OPTIONS, PR #298's rule: no unbounded
//      Stripe wait on a request path).
//
// IMPORT-FREE on purpose: the route's contract tests load it through
// test/helpers/pure-libs.mjs as the real module. Keep it that way.

/** The stable error code a blocked plan checkout returns (HTTP 409). */
export const PLAN_ALREADY_ACTIVE = 'PLAN_ALREADY_ACTIVE';

/** Every subscriptions.status (migration 013) except `canceled`. Pinned equal to
 *  pricing-plan-state.ts LIVE_SUBSCRIPTION_STATUSES by test/checkout-live-sub-block.test.mjs. */
export const CHECKOUT_LIVE_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'incomplete'] as const;

/** Where the user changes or cancels a plan: /account holds the portal button. */
export const MANAGE_PLAN_PATH = '/account';

/** Copy (one sentence of what happened, one of what to do; error-copy-shape rule).
 *  `live` mirrors ERROR_COPY.PLAN_ALREADY_ACTIVE. `pending` is for a subscription
 *  that exists but is not yet fully on our side (incomplete, or the webhook has
 *  not landed), where /account may not show the portal button yet. */
export const PLAN_ALREADY_ACTIVE_COPY = {
  live: {
    headline: 'You already have a plan.',
    action: 'To change or cancel it, use Manage subscription on your Account page.',
  },
  pending: {
    headline: 'Your plan is still being set up.',
    action: 'Give it a minute, then manage it from your Account page.',
  },
} as const;

export type LiveSubscriptionReason = 'live' | 'pending';

export type LiveSubscriptionFinding = {
  /** Where it was found. */
  source: 'db_subscription' | 'db_paid_entitlement' | 'provider';
  /** The subscription status (or the entitlement plan code for db_paid_entitlement). */
  status: string;
  reason: LiveSubscriptionReason;
};

type Query = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * Zero rows: nothing blocks. One row: the first thing that does. A live
 * subscription is preferred over the entitlements-only case. Deliberately not a
 * SELECT EXISTS: an empty result is the "clear" answer, so a read that returns
 * nothing cannot be mistaken for a live subscription, and a thrown error is the
 * only "unknown".
 */
export const LIVE_SUBSCRIPTION_SQL = `
  SELECT source, status FROM (
    SELECT 'db_subscription' AS source, s.status::text AS status, 0 AS rank, s.updated_at AS at
      FROM subscriptions s
     WHERE s.user_id = $1 AND s.provider = $2 AND s.status = ANY($3::text[])
    UNION ALL
    SELECT 'db_paid_entitlement', e.plan_code::text, 1, NULL
      FROM entitlements e
     WHERE e.user_id = $1 AND e.plan_code <> 'free'
       AND NOT EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.user_id = $1 AND s2.provider = $2)
  ) x
  ORDER BY rank, at DESC NULLS LAST
  LIMIT 1`;

/** The DB check. Throws when the read fails (the route answers 502, never
 *  "clear": failing open here is exactly the double subscription). */
export async function findLiveSubscriptionInDb(
  query: Query,
  userId: string,
  provider: string,
): Promise<LiveSubscriptionFinding | null> {
  const res = await query(LIVE_SUBSCRIPTION_SQL, [userId, provider, [...CHECKOUT_LIVE_STATUSES]]);
  const row = res.rows[0];
  if (!row) return null;
  const source = row.source === 'db_paid_entitlement' ? 'db_paid_entitlement' : 'db_subscription';
  const status = String(row.status ?? '');
  const reason: LiveSubscriptionReason =
    source === 'db_paid_entitlement' || status === 'incomplete' ? 'pending' : 'live';
  return { source, status, reason };
}

/** The provider fallback's answer, turned into a finding (or null when none). */
export function findingFromProvider(
  subs: ReadonlyArray<{ id: string; status: string }>,
): LiveSubscriptionFinding | null {
  const first = subs[0];
  if (!first) return null;
  // Our DB has no live row for it, so the webhook has not landed: "being set up".
  return { source: 'provider', status: first.status, reason: 'pending' };
}

/** The 409 body: { error, code, reason, manage_url }. */
export function planAlreadyActiveBody(finding: LiveSubscriptionFinding): {
  error: string;
  code: typeof PLAN_ALREADY_ACTIVE;
  reason: LiveSubscriptionReason;
  manage_url: string;
} {
  const copy = PLAN_ALREADY_ACTIVE_COPY[finding.reason];
  return {
    error: `${copy.headline} ${copy.action}`,
    code: PLAN_ALREADY_ACTIVE,
    reason: finding.reason,
    manage_url: MANAGE_PLAN_PATH,
  };
}
