// POST /api/billing/webhook
// Stripe webhook receiver. Fulfills purchases + syncs subscription state.
//
// Critical rules
// --------------
// 1. SIGNATURE VERIFICATION IS MANDATORY. Any request that fails
//    stripe.webhooks.constructEvent is a potential forgery and gets 400.
// 2. The raw request bytes are required for verification. req.json() parses
//    and reserializes, which breaks the HMAC. We use req.text() and let the
//    SDK parse.
// 3. Fulfillment must be IDEMPOTENT. Stripe retries on any non-2xx for up to
//    3 days; the same event can arrive many times. Every DB write uses
//    ON CONFLICT ... DO NOTHING / DO UPDATE on a unique-keyed column
//    (stripe_payment_intent_id / stripe_subscription_id).
// 4. Return 200 quickly. A slow response (> ~30 s) makes Stripe retry.
//    We do the DB writes inline (fast) and defer nothing.
// 5. Handle BOTH checkout.session.completed AND
//    checkout.session.async_payment_succeeded. For instant-settle methods
//    (card) only the former fires; for delayed methods (SEPA, bank debit)
//    the former fires with payment_status=unpaid first, THEN the latter
//    fires when the money arrives. Fulfill on either, gated on
//    session.payment_status === 'paid' (or mode === 'subscription',
//    since subs are created even if the trial is unpaid).
//
// Subscribed events (configure in Stripe Dashboard webhook endpoint):
//   checkout.session.completed
//   checkout.session.async_payment_succeeded
//   invoice.paid
//   invoice.payment_failed
//   customer.subscription.updated
//   customer.subscription.deleted
//   charge.dispute.created         (logged, no state change)
//   charge.refunded                (logged, no state change in this PR)

import type Stripe from 'stripe';
import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { db } from '@/lib/db';
import {
  isBillingSku,
  skuToCredits,
  subscriptionCapability,
  type BillingSku,
} from '@/lib/billing-skus';

// Next.js App Router: keep the function on the Node runtime (not edge) so
// `req.text()` returns the exact raw bytes and the Stripe SDK's constructEvent
// can HMAC them.
export const runtime = 'nodejs';
// Don't cache — every webhook POST must execute.
export const dynamic = 'force-dynamic';

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'missing signature' }, { status: 400 });
  }

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      raw,
      sig,
      envOrThrow('STRIPE_WEBHOOK_SECRET'),
    );
  } catch (err) {
    // Includes signature-mismatch, timestamp-skew, missing secret.
    return NextResponse.json(
      {
        error: 'webhook signature verification failed',
        message: err instanceof Error ? err.message : 'unknown',
      },
      { status: 400 },
    );
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutSession(event.data.object as Stripe.Checkout.Session);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        // Dunning signal. Keep the subscription row's status updated via the
        // customer.subscription.updated event that follows; nothing to insert
        // here beyond a structured log.
        console.warn(
          '[stripe-webhook] invoice.payment_failed',
          (event.data.object as Stripe.Invoice).id,
        );
        break;

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await upsertSubscription(
          event.data.object as Stripe.Subscription,
          /* deleted */ event.type === 'customer.subscription.deleted',
        );
        break;

      case 'charge.dispute.created':
      case 'charge.refunded':
        // Not in scope for this PR — log only. A follow-up ticket revokes
        // the entitlement and records the refund.
        console.warn(`[stripe-webhook] ${event.type}`, event.id);
        break;

      default:
        // Unknown event types are OK — the endpoint intentionally subscribes
        // to a narrow set. Returning 200 prevents Stripe from retrying.
        break;
    }
  } catch (err) {
    // Any DB or logic error after a VALID signature is a 500 so Stripe will
    // retry. The outer catch logs and re-rethrows the exception message so the
    // retry has a chance to succeed.
    console.error('[stripe-webhook] handler error', event.type, err);
    return NextResponse.json(
      { error: 'handler failed', event_type: event.type },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true, event_type: event.type });
}

// --- handlers ----------------------------------------------------------------

async function handleCheckoutSession(session: Stripe.Checkout.Session) {
  // Attribution comes from the metadata we set at checkout-create time.
  const userId = session.metadata?.user_id;
  const skuRaw = session.metadata?.sku;
  if (!userId || !isBillingSku(skuRaw)) {
    console.warn('[stripe-webhook] checkout.session without user_id/sku metadata', session.id);
    return;
  }
  const sku: BillingSku = skuRaw;

  // Delayed-method sessions reach checkout.session.completed with
  // payment_status=unpaid; fulfill only once payment_status=paid, OR when the
  // session created a subscription (subscription trials can be unpaid).
  if (session.mode === 'payment') {
    if (session.payment_status !== 'paid') return;
    await insertCreditPurchase(userId, sku, session);
  } else if (session.mode === 'subscription' && session.subscription) {
    // The subscription object itself arrives via customer.subscription.updated;
    // nothing to persist here.
  }
}

async function insertCreditPurchase(
  userId: string,
  sku: BillingSku,
  session: Stripe.Checkout.Session,
) {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    console.warn('[stripe-webhook] checkout.session.completed without payment_intent', session.id);
    return;
  }

  const credits = skuToCredits(sku);
  if (credits === 0) return;

  const priceId = session.line_items?.data?.[0]?.price?.id ?? '';
  const amountCents = session.amount_total ?? 0;
  const currency = session.currency ?? 'cad';

  // ON CONFLICT DO NOTHING on the UNIQUE stripe_payment_intent_id means a
  // webhook replay (Stripe retries, two events for the same intent) is a no-op.
  await db.query(
    `INSERT INTO credit_purchases
       (user_id, stripe_payment_intent_id, stripe_price_id, sku,
        credits_granted, amount_cents, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [userId, paymentIntentId, priceId, sku, credits, amountCents, currency],
  );
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  // A subscription renewal: resync the subscription row + its entitlement
  // via the subscription object itself on the next customer.subscription.updated
  // event (Stripe sends it together with invoice.paid). Nothing to do here
  // beyond a structured log — the up-to-date state arrives in that event.
  console.info('[stripe-webhook] invoice.paid', invoice.id);
}

async function upsertSubscription(
  sub: Stripe.Subscription,
  deleted: boolean,
) {
  const userId = sub.metadata?.user_id;
  const skuRaw = sub.metadata?.sku;
  if (!userId || !isBillingSku(skuRaw)) {
    console.warn('[stripe-webhook] subscription missing user_id/sku metadata', sub.id);
    return;
  }
  const sku: BillingSku = skuRaw;

  // In API version 2026-03-25.dahlia+ the billing period moved from the
  // Subscription itself to each SubscriptionItem. We currently create one
  // item per subscription, so item[0] is authoritative.
  const firstItem = sub.items.data[0];
  const priceId = firstItem?.price.id ?? '';
  const periodStart = firstItem?.current_period_start ?? 0;
  const periodEnd = firstItem?.current_period_end ?? 0;
  // On .deleted events Stripe sends the subscription with status='canceled';
  // we honour that either way.
  const status = deleted ? 'canceled' : sub.status;

  await db.query(
    `INSERT INTO subscriptions
       (user_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
        sku, status, current_period_start, current_period_end,
        cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8), $9)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       status                = EXCLUDED.status,
       stripe_price_id       = EXCLUDED.stripe_price_id,
       sku                   = EXCLUDED.sku,
       current_period_start  = EXCLUDED.current_period_start,
       current_period_end    = EXCLUDED.current_period_end,
       cancel_at_period_end  = EXCLUDED.cancel_at_period_end,
       updated_at            = now()`,
    [
      userId,
      sub.id,
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
      priceId,
      sku,
      status,
      periodStart,
      periodEnd,
      sub.cancel_at_period_end,
    ],
  );

  // Mirror the subscription into entitlements. Grant while active-ish;
  // revoke when canceled/unpaid.
  const capability = subscriptionCapability(sku);
  if (!capability) return;
  const activeStatus = ['trialing', 'active', 'past_due'].includes(status);
  if (activeStatus) {
    await db.query(
      `INSERT INTO entitlements
         (user_id, capability, granted_via, source_id, expires_at)
       VALUES ($1, $2, 'subscription', NULL, to_timestamp($3))
       ON CONFLICT (user_id, capability, granted_via) DO UPDATE SET
         expires_at = EXCLUDED.expires_at`,
      [userId, capability, periodEnd],
    );
  } else {
    await db.query(
      `DELETE FROM entitlements
        WHERE user_id = $1 AND capability = $2 AND granted_via = 'subscription'`,
      [userId, capability],
    );
  }
}
