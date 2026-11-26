// The beta checkout switch (B-8w "P"; Jon, 2026-11-25: "P hide checkout during beta").
//
// Stripe stays in sandbox until January, so during the beta nothing may start a purchase.
// ONE server-side switch decides it, read at request time:
//
//   BILLING_CHECKOUT_ENABLED=true   -> checkout is offered and POST /api/billing/checkout works
//   anything else, or unset         -> checkout is OFF (the default: fail closed)
//
// Only the exact lowercase string 'true' turns it on. 'TRUE', '1', 'yes', ' true', '' and
// unset all mean OFF, so a typo or a missing variable can never open a purchase path. It is a
// server variable (no NEXT_PUBLIC_ prefix): the browser never decides, the page and the route
// read it on the server.
//
// When OFF:
//   - /pricing still shows every plan and credit pack with its price, but each purchase
//     action is replaced by non-purchasable copy (CHECKOUT_DISABLED_LABEL), with no
//     BillingButton, no PackBuyButton, no hCaptcha and no "Get <plan>" sign-in link
//     (lib/pricing-copy.ts planCta -> kind 'unavailable'; app/pricing/page.tsx);
//   - POST /api/billing/checkout answers 403 CHECKOUT_DISABLED before auth, the body, the
//     database or any billing-provider call (app/api/billing/checkout/route.ts).
// The billing portal (/api/billing/portal) is untouched: it serves existing subscribers only.
//
// Re-enable (January): set BILLING_CHECKOUT_ENABLED=true in the web app's environment and
// redeploy. Import-free, so route and page tests can load the real module.

export const CHECKOUT_ENV = 'BILLING_CHECKOUT_ENABLED';

/** The typed refusal code POST /api/billing/checkout returns (HTTP 403) while checkout is off. */
export const CHECKOUT_DISABLED = 'CHECKOUT_DISABLED';

/** What a plan or credit-pack card shows instead of a purchase action while checkout is off. */
export const CHECKOUT_DISABLED_LABEL = 'Coming soon — free during the beta';

/** Pure parse: only the exact string 'true' enables checkout. */
export function checkoutEnabledFromEnv(value: string | undefined | null): boolean {
  return value === 'true';
}

/** Whether checkout may be offered or started right now. Read per call, never cached. */
export function isCheckoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return checkoutEnabledFromEnv(env[CHECKOUT_ENV]);
}
