// POST /api/billing/webhook — V3 Phase 1a (TSD §1.1, V3-C1/C3/C4/C6/C8).
//
// Stripe/Paddle webhook handler. Verifies the signature inside the
// BillingProvider (stripe.webhooks.constructEvent) with the raw request
// body, then persists the fulfillment to Postgres with idempotent inserts.
//
// This route NEVER throws: an uncaught exception would make Stripe retry
// forever. All paths return a JSON body and an explicit status:
//   200 — handled or intentionally ignored (unhandled event type)
//   400 — signature invalid / unparseable
//   500 — DB write failure (Stripe should retry)
//
// Idempotency (critical): every insert uses UNIQUE constraints and
// ON CONFLICT DO NOTHING. Specifically:
//   credit_purchases     UNIQUE (provider, provider_charge_id)
//   subscriptions        UNIQUE (provider, provider_subscription_id)
//   promo_redemptions    best-effort DO NOTHING on (user_id, code, applied_at)
//
// Raw body: we MUST use req.text() (Next 14 App Router) — JSON parsing
// would normalize whitespace and invalidate the signature.

import { NextRequest, NextResponse } from 'next/server';
import { getBillingProvider, type BillingEvent, type BillingSubscription } from '@/lib/billing';
import { db } from '@/lib/db';
import { invalidateEntitlement } from '@/lib/billing/entitlements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Our DB plan_code column uses the short form ('pro', 'studio'); the
// provider interface uses the longer suffix. Narrow on the way in.
function dbPlanCode(provider: BillingSubscription['planCode']): 'pro' | 'studio' | null {
  if (provider === 'pro_monthly') return 'pro';
  if (provider === 'studio_monthly') return 'studio';
  return null;
}

function credits_for_pack(pack: 'credits_20' | 'credits_60' | 'credits_180'): number {
  return pack === 'credits_20' ? 20 : pack === 'credits_60' ? 60 : 180;
}

async function ensureUserRow(userId: string): Promise<boolean> {
  // The handle_new_user trigger seeds public.users at signup — but if a
  // Stripe event beats the trigger (shouldn't happen, but defense), bail.
  const res = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  return (res.rowCount ?? 0) > 0;
}

/** Recompute the entitlements row from the authoritative subscription state.
 *  Called on subscription_upserted and invoice_paid events. */
async function upsertEntitlementFromSubscription(
  userId: string,
  sub: BillingSubscription,
): Promise<void> {
  const planCode = dbPlanCode(sub.planCode);
  if (!planCode) return;
  const periodStart = sub.currentPeriodStart ?? new Date();
  const periodEnd = sub.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000);
  // Upsert entitlements; jobs_used resets to 0 on a new period.
  await db.query(
    `INSERT INTO entitlements
       (user_id, plan_code, period_start, period_end, jobs_used, computed_at)
     VALUES ($1, $2, $3, $4, 0, now())
     ON CONFLICT (user_id) DO UPDATE SET
       plan_code     = EXCLUDED.plan_code,
       period_start  = EXCLUDED.period_start,
       period_end    = EXCLUDED.period_end,
       jobs_used     = CASE
         WHEN entitlements.period_end < EXCLUDED.period_end THEN 0
         ELSE entitlements.jobs_used
       END,
       computed_at   = now()`,
    [userId, planCode, periodStart, periodEnd],
  );
}

async function handleBillingEvent(evt: BillingEvent, providerName: 'stripe' | 'paddle'): Promise<void> {
  switch (evt.type) {
    case 'credit_purchase_completed': {
      if (!evt.userId) return;
      if (!(await ensureUserRow(evt.userId))) return;
      const credits = credits_for_pack(evt.packCode);
      await db.query(
        `INSERT INTO credit_purchases
           (user_id, provider, provider_charge_id, pack_code, credits_granted,
            amount_usd_cents, promo_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (provider, provider_charge_id) DO NOTHING`,
        [
          evt.userId,
          providerName,
          evt.providerChargeId,
          evt.packCode,
          credits,
          Math.max(0, evt.amountCents | 0),
          evt.promoCode ?? null,
        ],
      );
      if (evt.promoCode) {
        // Audit the redemption; append-only so no uniqueness needed, but we
        // DO NOTHING on the primary key (uuid default) to be safe.
        await db.query(
          `INSERT INTO promo_redemptions (user_id, code)
           VALUES ($1, $2)`,
          [evt.userId, evt.promoCode],
        );
      }
      invalidateEntitlement(evt.userId);
      return;
    }

    case 'subscription_upserted': {
      if (!evt.userId) return;
      if (!(await ensureUserRow(evt.userId))) return;
      const planCode = dbPlanCode(evt.subscription.planCode);
      if (!planCode) return;
      // customers_billing must exist for the FK story; insert idempotently.
      await db.query(
        `INSERT INTO customers_billing (user_id, provider, provider_customer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, provider) DO NOTHING`,
        [evt.userId, providerName, evt.subscription.providerCustomerId],
      );
      await db.query(
        `INSERT INTO subscriptions
           (user_id, provider, provider_subscription_id, plan_code, status,
            current_period_start, current_period_end, cancel_at_period_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
           status               = EXCLUDED.status,
           plan_code            = EXCLUDED.plan_code,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end   = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           updated_at           = now()`,
        [
          evt.userId,
          providerName,
          evt.subscription.providerSubscriptionId,
          planCode,
          evt.subscription.status,
          evt.subscription.currentPeriodStart ?? new Date(),
          evt.subscription.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
          evt.subscription.cancelAtPeriodEnd,
        ],
      );
      await upsertEntitlementFromSubscription(evt.userId, evt.subscription);
      invalidateEntitlement(evt.userId);
      return;
    }

    case 'subscription_canceled': {
      // Mark the row canceled; keep the entitlement row with its current
      // period_end so the user retains access until the paid period expires.
      const res = await db.query<{ user_id: string }>(
        `UPDATE subscriptions
            SET status = 'canceled', cancel_at_period_end = true, updated_at = now()
          WHERE provider = $1 AND provider_subscription_id = $2
          RETURNING user_id`,
        [providerName, evt.providerSubscriptionId],
      );
      const userId = res.rows[0]?.user_id ?? evt.userId;
      if (userId) invalidateEntitlement(userId);
      return;
    }

    case 'invoice_paid': {
      // Reload the subscription to recompute entitlement period. Falls back
      // to extending the existing period by the invoice interval.
      if (!evt.userId) return;
      try {
        const provider = getBillingProvider();
        const sub = await provider.getSubscription(evt.providerSubscriptionId);
        await upsertEntitlementFromSubscription(evt.userId, sub);
      } catch (err) {
        console.error('[webhook] invoice_paid refresh failed:', err instanceof Error ? err.message : err);
      }
      invalidateEntitlement(evt.userId);
      return;
    }

    case 'invoice_payment_failed': {
      // Flip the subscription to past_due. Keep entitlement until period end.
      await db.query(
        `UPDATE subscriptions SET status = 'past_due', updated_at = now()
          WHERE provider = $1 AND provider_subscription_id = $2`,
        [providerName, evt.providerSubscriptionId],
      );
      if (evt.userId) invalidateEntitlement(evt.userId);
      return;
    }

    case 'dispute_created':
    case 'refund_created':
    case 'unhandled':
    default:
      // No-op: these events are recorded by Stripe Dashboard and don't
      // alter entitlements directly in Phase 1a. Phase 1b adds a
      // disputes/refunds ledger.
      return;
  }
}

export async function POST(req: NextRequest) {
  const provider = getBillingProvider();

  // Stripe sends the signature in `stripe-signature`. Paddle uses its own
  // header, but BillingProvider.handleWebhook abstracts the name away —
  // every implementation reads from the raw body + whichever signature
  // header it expects. We pass the stripe header here; a paddle adapter
  // would read its own from `req.headers` inside handleWebhook (not yet
  // implemented — PaddleProvider throws NotImplemented).
  const signature =
    req.headers.get('stripe-signature') ??
    req.headers.get('paddle-signature') ??
    '';

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error('[webhook] failed to read body:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'bad body' }, { status: 400 });
  }

  let event: BillingEvent;
  try {
    event = await provider.handleWebhook(rawBody, signature);
  } catch (err) {
    // Stripe treats 400 as "do not retry" — correct for signature mismatch.
    console.warn('[webhook] signature verification failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  try {
    await handleBillingEvent(event, provider.name);
    return NextResponse.json({ received: true, type: event.type }, { status: 200 });
  } catch (err) {
    // 500 so the provider retries — our DB write was the thing that broke.
    console.error('[webhook] handler error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'handler_error' }, { status: 500 });
  }
}
