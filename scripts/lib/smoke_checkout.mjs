// smoke_checkout.mjs — the beta checkout posture, as scripts/smoke_staging.mjs sees it (#453).
//
// During the beta, checkout is hidden: the web app's POST /api/billing/checkout answers
// HTTP 403 { code: 'CHECKOUT_DISABLED' } unless BILLING_CHECKOUT_ENABLED is exactly 'true'
// (apps/web/src/lib/billing/checkout-switch.ts, PR #455). That refusal comes after the CSRF
// check and before auth, the body, the DB, the hCaptcha gate and Stripe.
//
// For the smoke that is the EXPECTED beta posture, not a failure. Only this exact shape
// counts: a 403 with any other code (BAD_ORIGIN, ...), a non-JSON 403, or any other status
// is not "checkout hidden" and the caller fails it as before.
//
// Pure and import-free so a unit test can load it without the network.

/** The code the checkout route returns while checkout is hidden (mirrors checkout-switch.ts). */
export const CHECKOUT_DISABLED = 'CHECKOUT_DISABLED';

/** The detail line the smoke prints for the hidden posture. */
export const CHECKOUT_HIDDEN_OK = 'checkout hidden (beta) — OK';

/**
 * True only for the hidden-checkout refusal: HTTP 403 whose JSON body has
 * code === 'CHECKOUT_DISABLED'. `r` is the smoke's http() result: { status, json, text }.
 */
export function isCheckoutHidden(r) {
  return !!r && r.status === 403 && !!r.json && typeof r.json === 'object' && r.json.code === CHECKOUT_DISABLED;
}

/**
 * Steps 7 and 8 must agree: the switch is one server-wide env value, so one step seeing
 * checkout hidden and the other seeing it open means a deploy or env change landed
 * mid-run (or a route regression). Returns an error string, or null when consistent.
 * `seen` is the posture an earlier step recorded ('hidden' | 'open' | null).
 */
export function postureMismatch(seen, now) {
  if (!seen || !now || seen === now) return null;
  return `checkout posture changed mid-run: an earlier step saw checkout ${seen}, this one saw it ${now}`;
}
