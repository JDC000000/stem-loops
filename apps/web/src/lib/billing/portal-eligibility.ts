// Who sees "Manage subscription" on /account (emails v1.2 §3 R4, E6).
//
// The old rule ("plan_code !== 'free'") hid the button from exactly the people
// the billing emails send there: a paused subscriber, and a past_due one after
// the grace window, both read as 'free' through effectivePlanCode, so R4
// "paused" and R7 "Update your card" led to a page with no way to fix it.
//
// The rule now: the user has a subscription with the current billing
// provider that got past `incomplete` (it was paid at least once), AND a
// customers_billing row for that provider (the portal route's precondition,
// GET /api/billing/portal, which filters by provider). That excludes an
// abandoned Checkout (customers_billing is written before the session, and
// the subscription, if any, is still incomplete) and a credit-only buyer
// (no subscription at all). PR #272 review M-b.

import { db } from '@/lib/db';

/** The provider name the portal route uses (getBillingProvider().name). */
export function billingProviderName(env: Record<string, string | undefined> = process.env): string {
  return (env.BILLING_PROVIDER ?? 'stripe').toLowerCase();
}

/** True/false; null when the read failed. */
export async function hasPortalSubscription(
  userId: string,
  provider: string = billingProviderName(),
): Promise<boolean | null> {
  try {
    const res = await db.query(
      `SELECT 1 FROM subscriptions s
         JOIN customers_billing c ON c.user_id = s.user_id AND c.provider = s.provider
        WHERE s.user_id = $1 AND s.provider = $2 AND s.status <> 'incomplete'
        LIMIT 1`,
      [userId, provider],
    );
    return (res.rowCount ?? res.rows.length) > 0;
  } catch {
    return null;
  }
}

/**
 * Show the portal button when the user has a portal-backed subscription. If
 * that read failed, fall back to the old rule (a paid plan implies one).
 */
export function showManageSubscription(args: {
  hasPortalSubscription: boolean | null;
  planCode: string | null | undefined;
}): boolean {
  if (args.hasPortalSubscription !== null) return args.hasPortalSubscription;
  return !!args.planCode && args.planCode !== 'free';
}
