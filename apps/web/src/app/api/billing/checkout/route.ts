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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PACKS: ReadonlyArray<PackCode> = ['credits_20', 'credits_60', 'credits_180'];
// Public API uses the migration's plan codes ('pro' / 'studio'); the
// BillingProvider interface still carries the longer '_monthly' suffix,
// so we map on the way in. Keep the two codepaths in one place.
const PLAN_ALIASES: Record<string, Exclude<PlanCode, 'free'>> = {
  pro: 'pro_monthly',
  studio: 'studio_monthly',
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_USER = 3;

type Body = {
  pack_code?: unknown;
  plan_code?: unknown;
  promo_code?: unknown;
};

function badRequest(code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

/** Atomic rate check + record in usage_events. */
async function underCheckoutRateLimit(userId: string): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO usage_events (user_id, kind, detail)
     SELECT $1::uuid, 'billing_checkout_attempt', '{}'::jsonb
     WHERE (
       SELECT COUNT(*) FROM usage_events
        WHERE user_id = $1
          AND kind = 'billing_checkout_attempt'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')
     ) < $3
     RETURNING id`,
    [userId, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_PER_USER],
  );
  return (res.rowCount ?? 0) > 0;
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
  if (planRaw && !PLAN_ALIASES[planRaw]) {
    return badRequest('PLAN_NOT_FOUND', `Unknown plan_code: ${planRaw}`);
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

    let session;
    if (packRaw) {
      session = await provider.createCreditPurchaseSession(
        user.user_id,
        packRaw as PackCode,
        successUrl,
        cancelUrl,
      );
    } else {
      const mappedPlan = PLAN_ALIASES[planRaw as string];
      session = await provider.createCheckoutSession(
        user.user_id,
        mappedPlan,
        successUrl,
        cancelUrl,
      );
    }

    if (promoCode) {
      // Best-effort: Stripe applies promotion codes on the hosted page via
      // allow_promotion_codes, but we attempt a server-side attach in case
      // a future provider honors it.
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
