// POST /api/billing/checkout
// Create a Stripe-hosted Checkout Session for a credit-pack purchase or a
// subscription. Body: { sku: BillingSku }. Returns { url, session_id }.
//
// Auth: required. Unauthenticated → 401 UNAUTHENTICATED.
// Side effects:
//   * Upserts the users (public profile) row for the authenticated user.
//   * Creates a Stripe Customer the first time this user checks out, stores
//     stripe_customer_id on the profile for reuse.
//
// Fulfillment of the sale happens in POST /api/billing/webhook on
// checkout.session.completed (+ .async_payment_succeeded for delayed methods)
// — never on the success page.

import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getUser } from '@/lib/supabase-server';
import { db } from '@/lib/db';
import { isBillingSku, skuToPriceId, skuMode } from '@/lib/billing-skus';

// Per Stripe best-practices (API >= 2026-03-25.dahlia): include an
// integration_identifier with an 8-letter random suffix so this specific
// checkout flow shows up as its own column in Dashboard reports.
const INTEGRATION_ID = 'stem_loops_v3_hxkpqrst';

export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error_code: 'UNAUTHENTICATED', message: 'Sign in to buy credits.' },
      { status: 401 },
    );
  }

  let body: { sku?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error_code: 'INVALID_REQUEST', message: 'Body must be JSON.' },
      { status: 400 },
    );
  }

  if (!isBillingSku(body.sku)) {
    return NextResponse.json(
      { error_code: 'INVALID_SKU', message: 'Unknown SKU.' },
      { status: 400 },
    );
  }

  const sku = body.sku;
  const priceId = skuToPriceId(sku);
  const mode = skuMode(sku);

  // Ensure the profile row exists (so stripe_customer_id has a home).
  await db.query(
    `INSERT INTO users (id, email) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
    [user.id, user.email],
  );

  // Look up (or create) the Stripe customer for this user.
  const { rows } = await db.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [user.id],
  );
  const stripe = getStripe();
  let customerId = rows[0]?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
    await db.query(`UPDATE users SET stripe_customer_id = $1 WHERE id = $2`, [
      customerId,
      user.id,
    ]);
  }

  const origin = req.headers.get('origin') ?? 'https://stem-loops.com';

  const session = await stripe.checkout.sessions.create({
    mode,
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pricing`,
    // Metadata is what the webhook reads to attribute the sale back to our user.
    metadata: { user_id: user.id, sku },
    // Dashboard-side segmentation per Stripe best-practices skill.
    integration_identifier: INTEGRATION_ID,
    // Promo codes (LAUNCH20 etc.) can be entered on the Stripe-hosted page.
    allow_promotion_codes: true,
  });

  if (!session.url) {
    // Should never happen — Stripe returns url for the hosted flow.
    return NextResponse.json(
      { error_code: 'CHECKOUT_FAILED', message: 'Could not create checkout.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: session.url, session_id: session.id });
}
