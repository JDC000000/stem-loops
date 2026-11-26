// POST /api/billing/checkout — V3 Phase 1a (TSD §1.1, V3-C1).
//
// Body: { pack_code?: 'credits_20'|'credits_60'|'credits_180',
//         plan_code?: 'pro'|'studio',
//         promo_code?: string }
//
// Exactly one of pack_code / plan_code is required. Returns { checkout_url }
// or an error envelope { error, code } where `code` is an error_copy key.
//
// Auth: required via @/lib/auth/supabase getUser(). Unauthenticated -> 401.
// Rate limit: 3/min per authenticated user, recorded in usage_events.
//
// One subscription at a time (decision 1A, 2026-11-19): a plan_code checkout is
// refused with 409 PLAN_ALREADY_ACTIVE while the user has a live subscription
// (active, trialing, past_due, paused, incomplete). Plan changes go through the
// customer portal (/account). Credit packs are never blocked. See
// lib/billing/checkout-guard.ts for the DB check and the Stripe stale-sync
// fallback.
//
// Fulfillment of the sale happens in POST /api/billing/webhook — never on
// the success page (TSD §1.1 processor-abstraction + anti-goal: no business
// logic in the client-trusted success path).

import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { getBillingProvider, type PackCode, type PlanCode } from '@/lib/billing';
import { db } from '@/lib/db';
import { verifyHcaptchaToken } from '@/lib/hcaptcha';
import { appOrigin } from '@/lib/app-url';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import {
  findLiveSubscriptionInDb,
  findingFromProvider,
  planAlreadyActiveBody,
  type LiveSubscriptionFinding,
} from '@/lib/billing/checkout-guard';
import { CHECKOUT_DISABLED, isCheckoutEnabled } from '@/lib/billing/checkout-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PACKS: ReadonlyArray<PackCode> = ['credits_20', 'credits_60', 'credits_180'];
// Valid plan codes accepted on checkout. 'free' is excluded — the free
// tier is the anonymous device-fingerprint cohort (§1.2) and has no
// Stripe checkout flow. PR #29 aligned the BillingProvider PlanCode type
// with plans.code (both now 'free' | 'pro' | 'studio'), so no translation
// is needed on this boundary anymore.
const PAID_PLANS: ReadonlyArray<Exclude<PlanCode, 'free'>> = ['pro', 'studio'];

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_USER = 3;
// Postgres advisory lock namespace tag. Short string hashed via hashtext()
// gives a stable 32-bit integer key, safely partitioned from any other
// advisory-lock caller in the app.
const RATE_LIMIT_LOCK_TAG = 'billing_checkout';

type Body = {
  pack_code?: unknown;
  plan_code?: unknown;
  promo_code?: unknown;
  hcaptcha_token?: unknown;
};

function badRequest(code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

function checkoutFailed() {
  return NextResponse.json(
    { error: 'We could not start checkout.', code: 'CHECKOUT_FAILED' },
    { status: 502 },
  );
}

function planAlreadyActive(userId: string, finding: LiveSubscriptionFinding) {
  // No PII: the user id and what was found, so a refused checkout is traceable.
  console.warn(
    `[billing/checkout] refused plan checkout: live subscription (source=${finding.source} status=${finding.status}) user=${userId}`,
  );
  return NextResponse.json(planAlreadyActiveBody(finding), { status: 409 });
}

/** Atomic rate check + record in usage_events.
 *
 * Round-1 MEDIUM finding fix: the original single-statement INSERT ... SELECT
 * is READ COMMITTED, so two concurrent requests could both observe COUNT=2
 * and both insert → 4 checkouts in the window. Wrap the count+insert in a
 * transaction and take a per-user advisory lock AT THE TOP of the tx with
 * `pg_advisory_xact_lock(hashtext('billing_checkout:' || user_id))`. The
 * lock queues concurrent callers for the same user; advisory locks release
 * automatically at COMMIT/ROLLBACK, so there's no leak path.
 */
async function underCheckoutRateLimit(userId: string): Promise<boolean> {
  return db.tx(async (client) => {
    // Per-user advisory lock — concurrent requests for different users do
    // not block each other; same user serializes within the tx.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2::text))`,
      [RATE_LIMIT_LOCK_TAG, userId],
    );
    const countRes = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM usage_events
        WHERE user_id = $1::uuid
          AND kind = 'billing_checkout_attempt'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
      [userId, RATE_LIMIT_WINDOW_MS],
    );
    const n = Number.parseInt(countRes.rows[0]?.n ?? '0', 10);
    if (n >= RATE_LIMIT_PER_USER) return false;
    await client.query(
      `INSERT INTO usage_events (user_id, kind, detail)
       VALUES ($1::uuid, 'billing_checkout_attempt', '{}'::jsonb)`,
      [userId],
    );
    return true;
  });
}

export async function POST(req: NextRequest) {
  // CSRF (QA track B, B-06): same-origin browser requests only, before auth or the body.
  const originRefusal = crossOriginRefusal(req);
  if (originRefusal) {
    return NextResponse.json({ error: originRefusal, code: BAD_ORIGIN }, { status: 403 });
  }
  // B-8w "P" (Jon, 2026-11-25): checkout is off during the beta unless
  // BILLING_CHECKOUT_ENABLED=true (lib/billing/checkout-switch.ts; default off). Refused
  // before auth, the body, the database and any billing-provider call, so no purchase of a
  // plan or a credit pack can start while it is off, whoever calls.
  if (!isCheckoutEnabled()) {
    return NextResponse.json(
      { error: 'Checkout is not open during the beta.', code: CHECKOUT_DISABLED },
      { status: 403 },
    );
  }
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to buy credits.', code: 'UNAUTHENTICATED' },
      { status: 401 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return badRequest('CHECKOUT_FAILED', 'Body must be JSON.');
  }

  const packRaw = typeof body.pack_code === 'string' ? body.pack_code : null;
  const planRaw = typeof body.plan_code === 'string' ? body.plan_code : null;
  const promoRaw = typeof body.promo_code === 'string' ? body.promo_code.trim() : '';
  const promoCode = promoRaw.length > 0 ? promoRaw : null;

  if (!packRaw && !planRaw) {
    return badRequest('CHECKOUT_FAILED', 'Pass either pack_code or plan_code.');
  }
  if (packRaw && planRaw) {
    return badRequest('CHECKOUT_FAILED', 'Pass pack_code OR plan_code, not both.');
  }
  if (packRaw && !PACKS.includes(packRaw as PackCode)) {
    return badRequest('CHECKOUT_FAILED', `Unknown pack_code: ${packRaw}`);
  }
  if (planRaw && !PAID_PLANS.includes(planRaw as Exclude<PlanCode, 'free'>)) {
    // LOW round-1 fix: this is INPUT validation ("that string isn't a plan I
    // recognize"), not a billing-state "plan missing from the catalog" error.
    // CHECKOUT_FAILED reads correctly in error-copy; PLAN_NOT_FOUND is for
    // entitlements-side plan lookup failures.
    return badRequest('CHECKOUT_FAILED', `Unknown plan_code: ${planRaw}`);
  }

  // V3-C1: credit-pack purchases require a solved hCaptcha challenge.
  // Subscription checkout (plan_code) is NOT gated — authenticated + rate
  // limited already. Runs before the rate limiter so bot-challenge failures
  // don't burn the user's checkout slots; the limiter still applies after.
  if (packRaw) {
    const token = typeof body.hcaptcha_token === 'string' ? body.hcaptcha_token : '';
    const verdict = token
      ? await verifyHcaptchaToken(token, req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined)
      : { success: false };
    if (!verdict.success) {
      return NextResponse.json(
        { error: 'Bot check failed. Please try again.', code: 'BOT_CHALLENGE_FAILED' },
        { status: 400 },
      );
    }
  }

  const provider = getBillingProvider();

  // Decision 1A, check 1 (DB): refuse a plan checkout while a subscription is
  // live. Before the rate limiter, so a refusal does not burn checkout slots. A
  // failed read is a 502, never "clear".
  if (planRaw) {
    let finding: LiveSubscriptionFinding | null;
    try {
      finding = await findLiveSubscriptionInDb(db.query.bind(db), user.user_id, provider.name);
    } catch (err) {
      console.error(
        '[billing/checkout] live-subscription read failed:',
        err instanceof Error ? err.message : 'unknown error',
      );
      return checkoutFailed();
    }
    if (finding) return planAlreadyActive(user.user_id, finding);
  }

  if (!(await underCheckoutRateLimit(user.user_id))) {
    return NextResponse.json(
      { error: 'Too many checkout attempts. Wait a moment.', code: 'RATE_LIMITED' },
      { status: 429 },
    );
  }

  // QA track B, B-07: redirect targets come from config (lib/app-url.ts), never from the
  // request's Origin header, so a direct caller cannot make Stripe send a payer elsewhere.
  const origin = appOrigin();
  // The success page lives at app/success/page.tsx -> /success. This used to
  // point at /billing/success, and there is no app/billing/ route segment at
  // all (only app/api/billing/), so EVERY paying customer landed on a 404 the
  // instant they paid. Credits still arrived via the webhook, so nothing was
  // lost -- but the 404 hit at the worst possible moment. No rewrite or
  // redirect covered it; this was checked in next.config, vercel.json and
  // middleware before changing anything here.
  //
  // The page also reads `credits` as the PACK SIZE ("20" | "60" | "180"), not
  // the pack code ("credits_20"), so passing packRaw verbatim would silently
  // fall through to the generic "Your credits/subscription is active." Strip
  // the prefix so the confirmation names the pack the user actually bought.
  // Plan checkouts have no packRaw and correctly omit the param.
  const creditsParam = packRaw ? `&credits=${packRaw.replace(/^credits_/, '')}` : '';
  const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}${creditsParam}`;
  const cancelUrl = `${origin}/pricing`;

  try {
    // Ensure the public.users profile row exists before we persist any
    // customer_id. The handle_new_user trigger seeds this on signup, but
    // dev fixtures can miss it; upsert defensively.
    await db.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [user.user_id, user.email],
    );

    // Reuse (or mint) the provider-side customer. Stored per-provider in
    // customers_billing per TSD §2.3.
    const providerName = provider.name;
    const existing = await db.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id
         FROM customers_billing
        WHERE user_id = $1 AND provider = $2`,
      [user.user_id, providerName],
    );
    let providerCustomerId = existing.rows[0]?.provider_customer_id ?? null;

    // Decision 1A, check 2 (stale sync): the DB was clear, but a Checkout that
    // completed seconds ago may not have reached the webhook yet. A customer we
    // stored before this request may own such a subscription, so ask the
    // provider (one bounded read, STRIPE_CHECKOUT_READ_OPTIONS). A customer
    // minted below, in this request, cannot have one. A failed read throws to
    // the catch below: 502, never "clear".
    if (planRaw && providerCustomerId && provider.listLiveSubscriptions) {
      const finding = findingFromProvider(await provider.listLiveSubscriptions(providerCustomerId));
      if (finding) return planAlreadyActive(user.user_id, finding);
    }
    if (!providerCustomerId) {
      const cust = await provider.createCustomer(user.user_id, user.email);
      providerCustomerId = cust.providerCustomerId;
      await db.query(
        `INSERT INTO customers_billing (user_id, provider, provider_customer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, provider) DO NOTHING`,
        [user.user_id, providerName, providerCustomerId],
      );
    }

    // M7: resolve the Stripe promotion_code id up front so it rides in session
    // metadata and the webhook can de-dup promo_redemptions on retries.
    // Failure/not-found -> null -> checkout proceeds without the audit key.
    let promoCodeId: string | null = null;
    if (promoCode && provider.resolvePromotionCodeId) {
      try {
        promoCodeId = await provider.resolvePromotionCodeId(promoCode);
      } catch {
        promoCodeId = null;
      }
    }

    let session;
    if (packRaw) {
      session = await provider.createCreditPurchaseSession(
        user.user_id,
        packRaw as PackCode,
        successUrl,
        cancelUrl,
        promoCode,
        promoCodeId,
        // Without this the provider omits `customer:` and Stripe mints a
        // throwaway customer per session, so the customer we just stored
        // above stays empty and /api/billing/portal opens the wrong one --
        // a subscriber then cannot cancel or see invoices (#148).
        providerCustomerId,
      );
    } else {
      session = await provider.createCheckoutSession(
        user.user_id,
        planRaw as Exclude<PlanCode, 'free'>,
        successUrl,
        cancelUrl,
        promoCode,
        promoCodeId,
        // See the credit-pack call above: required for the Customer Portal to
        // resolve, and for subscription_data.metadata to ride on the real
        // customer rather than a throwaway one (#148).
        providerCustomerId,
      );
    }

    if (promoCode) {
      // Best-effort: Stripe applies promotion codes on the hosted page via
      // allow_promotion_codes, but we attempt a server-side attach in case
      // a future provider honors it. The code is also threaded into session
      // metadata (above) so the webhook can audit the redemption.
      try {
        await provider.applyPromoCode(session.sessionId, promoCode);
      } catch {
        // swallow — code validation happens on the hosted page
      }
    }

    return NextResponse.json({ checkout_url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[billing/checkout] failed:', message);
    return checkoutFailed();
  }
}
