// Who sees "Manage subscription" on /account (emails v1.2 §3 R4, E6).
//
// The Stripe portal route's only precondition is a customers_billing row. The
// old rule ("plan_code !== 'free'") hid the button from exactly the people the
// billing emails send there: a paused subscriber, an incomplete one, and a
// past_due one after the grace window all read as 'free' through
// effectivePlanCode, so R4 "paused" and R7 "Update your card" led to a page
// with no way to update the card.

import { db } from '@/lib/db';

/** True/false from customers_billing; null when the read failed. */
export async function hasBillingCustomer(userId: string): Promise<boolean | null> {
  try {
    const res = await db.query('SELECT 1 FROM customers_billing WHERE user_id = $1 LIMIT 1', [userId]);
    return (res.rowCount ?? res.rows.length) > 0;
  } catch {
    return null;
  }
}

/**
 * Show the portal button when the user has a billing customer. If that read
 * failed, fall back to the old rule (a paid plan implies a customer row).
 */
export function showManageSubscription(args: {
  hasBillingCustomer: boolean | null;
  planCode: string | null | undefined;
}): boolean {
  if (args.hasBillingCustomer !== null) return args.hasBillingCustomer;
  return !!args.planCode && args.planCode !== 'free';
}
