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
// Fulfillment of the sale happens in POST /api/billing/webhook — never on
// the success page (TSD §1.1 processor-abstraction + anti-goal: no business
// logic in the client-trusted success path).

import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { getBillingProvider, type PackCode, type PlanCode } from '@/lib/billing';
import { db } from '@/lib/db';
import { verifyHcaptchaToken } from '@/lib/hcaptcha';

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

  if (!(await underCheckoutRateLimit(user.user_id))) {
    return NextResponse.json(
      { error: 'Too many checkout attempts. Wait a moment.', code: 'RATE_LIMITED' },
      { status: 429 },
    );
  }

  const provider = getBillingProvider();
  const origin = req.headers.get('origin') ?? 'https://stem-loops.com';
  const successUrl = `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
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
      );
    } else {
      session = await provider.createCheckoutSession(
        user.user_id,
        planRaw as Exclude<PlanCode, 'free'>,
        successUrl,
        cancelUrl,
        promoCode,
        promoCodeId,
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
    return NextResponse.json(
      { error: 'We could not start checkout.', code: 'CHECKOUT_FAILED' },
      { status: 502 },
    );
  }
}
