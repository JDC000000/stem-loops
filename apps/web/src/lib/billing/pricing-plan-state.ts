// Display-only read for /pricing (QA A-10; review of #301, R2-2). READ ONLY: this
// module never writes, never calls the billing provider, and is not on the
// checkout path.
//
// /pricing offers a plan checkout only to a viewer on Free. But "Free" there is the
// EFFECTIVE plan (getEntitlementSnapshot -> effectivePlanCode), which reads 'free'
// for several viewers who still have a live subscription that /api/billing/checkout
// would duplicate (it opens a new subscription; since 1A it also refuses one server-side,
// lib/billing/checkout-guard.ts, which uses the same live statuses):
//   * past_due beyond the 7-day grace (Stripe is still dunning the card);
//   * paused (resumable);
//   * active, but entitlements.period_end has passed (a late renewal webhook);
//   * incomplete (first payment or 3DS pending);
//   * an entitlements row on a paid plan with NO subscriptions row yet (webhook
//     ordering: the subscription upsert has not landed).
// For those, the page must not treat the viewer as Free. A viewer whose only
// subscriptions are `canceled` IS Free and may resubscribe, so canceled is not live.

import { db } from '@/lib/db';
import { billingProviderName } from '@/lib/billing/portal-eligibility';

/** Every subscriptions.status (migration 013) except `canceled`. */
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'incomplete'] as const;

/**
 * True when a viewer whose effective plan is Free still has (or is about to have) a
 * subscription a new checkout would duplicate; false when they are plainly Free;
 * null when the read failed (the page treats that as unknown too).
 */
export async function freeViewerHasLiveSubscription(
  userId: string,
  provider: string = billingProviderName(),
): Promise<boolean | null> {
  try {
    const res = await db.query<{ live: boolean; any_sub: boolean; paid_row: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM subscriptions
                  WHERE user_id = $1 AND provider = $2 AND status = ANY($3::text[])) AS live,
         EXISTS (SELECT 1 FROM subscriptions WHERE user_id = $1 AND provider = $2) AS any_sub,
         EXISTS (SELECT 1 FROM entitlements WHERE user_id = $1 AND plan_code <> 'free') AS paid_row`,
      [userId, provider, [...LIVE_SUBSCRIPTION_STATUSES]],
    );
    const r = res.rows[0];
    if (!r) return null;
    // A live subscription, or a paid entitlements row with no subscription row at all
    // (the webhook has not written it yet). Canceled-only rows are neither.
    return r.live === true || (r.paid_row === true && r.any_sub !== true);
  } catch {
    return null;
  }
}
