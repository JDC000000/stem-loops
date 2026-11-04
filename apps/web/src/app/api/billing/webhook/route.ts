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
//   credit_adjustments   UNIQUE (provider, provider_event_id)  (migration 023)
//   subscriptions        UNIQUE (provider, provider_subscription_id)
//   promo_redemptions    UNIQUE (user_id, stripe_promotion_code_id)  (migration 015;
//                        de-dups only when stripe_promotion_code_id is non-NULL; checkout
//                        resolves it into session.metadata since M7 — see migration 015)
//
// Raw body: we MUST use req.text() (Next 14 App Router) — JSON parsing
// would normalize whitespace and invalidate the signature.

import { NextRequest, NextResponse } from 'next/server';
import { getBillingProvider, type BillingEvent, type BillingSubscription } from '@/lib/billing';
import { db } from '@/lib/db';
import { invalidateEntitlement } from '@/lib/billing/entitlements';
import {
  sendReceipt,
  sendSubscriptionChanged,
  sendWelcomeIfFirstTime,
} from '@/lib/emails/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PR #29 aligned BillingProvider's PlanCode with plans.code ('free' | 'pro' |
// 'studio'), so no translation is needed anymore. We just narrow 'free' out,
// which is not a valid subscription plan (TSD §1.2).
function dbPlanCode(provider: BillingSubscription['planCode']): 'pro' | 'studio' | null {
  return provider === 'pro' || provider === 'studio' ? provider : null;
}

function credits_for_pack(pack: 'credits_20' | 'credits_60' | 'credits_180'): number {
  return pack === 'credits_20' ? 20 : pack === 'credits_60' ? 60 : 180;
}

/**
 * Round-1 MEDIUM fix: the previous `bail if missing` version silently returned
 * 200 whenever a Stripe webhook beat the `handle_new_user` trigger — the
 * customer paid, we never granted credits, and Stripe never retried because
 * the handler said OK. Now we defensively upsert the row (mirroring the
 * checkout route's defense at route.ts:114-118), and if the upsert itself
 * fails we THROW — the route's outer catch turns that into a 500 and Stripe
 * retries, which is exactly what we want.
 *
 * emailHint lets credit_purchase_completed pass session.customer_email so a
 * row can be seeded even when auth.users isn't readable from the webhook
 * (which uses the stemloops_app role, not the auth schema). Falls back to
 * a stable derived placeholder matching the handle_new_user trigger, so the
 * NOT NULL constraint is satisfied.
 */
async function ensureUserRow(userId: string, emailHint?: string | null): Promise<void> {
  // Fast-path: row already exists.
  const read = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if ((read.rowCount ?? 0) > 0) return;

  // Try to recover an email from auth.users first (the webhook role has
  // SELECT via the handle_new_user trigger's SECURITY DEFINER path in most
  // deployments, but may not in all — tolerate failure).
  let email = emailHint ?? null;
  if (!email) {
    try {
      const auth = await db.query<{ email: string | null }>(
        'SELECT email FROM auth.users WHERE id = $1',
        [userId],
      );
      email = auth.rows[0]?.email ?? null;
    } catch {
      // auth schema not readable from this role; keep going with derived email
    }
  }
  if (!email) {
    // Match the derived-email shape used by the handle_new_user trigger so
    // migration 013's citext UNIQUE doesn't later collide when the trigger
    // catches up.
    email = `${userId}@noemail.local`;
  }

  // Defensive upsert. If this throws (constraint violation other than the
  // handled conflict, pool exhaustion, etc.) let it propagate — the route's
  // outer catch returns 500 and Stripe retries.
  await db.query(
    `INSERT INTO users (id, email) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [userId, email],
  );
}

/**
 * Email sends are best-effort (TSD §M: "delivery is best-effort"). A Resend
 * outage or a template-side bug must NEVER cause Stripe to retry — that would
 * desync entitlements. Every email call goes through this swallow-and-log
 * helper so the webhook's existing DB error path is untouched.
 */
async function emailBestEffort(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(
      `[webhook] email dispatch failed (${label}):`,
      err instanceof Error ? err.message : err,
    );
  }
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
      // Defensive users-row upsert (round-1 MEDIUM): if the handle_new_user
      // trigger hasn't caught up, seed the row here so we actually grant
      // credits. On failure, this throws and the route returns 500 → Stripe
      // retries. Email hint comes from the Checkout Session.
      await ensureUserRow(evt.userId, evt.customerEmail ?? null);
      const credits = credits_for_pack(evt.packCode);
      await db.query(
        `INSERT INTO credit_purchases
           (user_id, provider, provider_charge_id, pack_code, credits_granted,
            amount_cad_cents, promo_code)
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
        // Audit the redemption. Migration 015's UNIQUE (user_id,
        // stripe_promotion_code_id) de-dups Stripe retries ONLY when the id is
        // non-NULL (NULLs are distinct). M7: checkout now resolves the id and
        // threads it via session.metadata.stripe_promotion_code_id. Sessions
        // created before this change (or with an unresolvable code) still
        // arrive with NULL and keep the Phase 1a behaviour.
        await db.query(
          `INSERT INTO promo_redemptions (user_id, code, stripe_promotion_code_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, stripe_promotion_code_id) DO NOTHING`,
          [evt.userId, evt.promoCode, evt.promoCodeId ?? null],
        );
      }
      invalidateEntitlement(evt.userId);
      // V3-M3 — receipt for one-time credit purchase. Idempotency key is
      // the Stripe charge / payment-intent id (stable across retries), so a
      // double-delivered webhook can't double-send the receipt.
      await emailBestEffort('receipt:credit_purchase', () =>
        sendReceipt(evt.userId, {
          amount_cad_cents: evt.amountCents,
          plan_or_pack_label: `${credits} credits (${evt.packCode})`,
          invoice_url: null,
          receipt_source: { kind: 'credit', provider_charge_id: evt.providerChargeId },
        }),
      );
      return;
    }

    case 'subscription_upserted': {
      if (!evt.userId) return;
      // Defensive users-row upsert; throws on failure so Stripe retries.
      await ensureUserRow(evt.userId, null);
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
      // V3-M1 + V3-M2 — welcome (first-time only) + subscription-changed.
      // Welcome is idempotent via users.welcomed_at (see dispatch.ts).
      await emailBestEffort('welcome:first_time', () =>
        sendWelcomeIfFirstTime(evt.userId),
      );
      await emailBestEffort('subscription_changed:upsert', () =>
        sendSubscriptionChanged(evt.userId, {
          plan_code: evt.subscription.planCode,
          status: evt.subscription.status,
          period_end: evt.subscription.currentPeriodEnd,
          provider_subscription_id: evt.subscription.providerSubscriptionId,
        }),
      );
      return;
    }

    case 'subscription_canceled': {
      // Mark the row canceled; keep the entitlement row with its current
      // period_end so the user retains access until the paid period expires.
      const res = await db.query<{ user_id: string; plan_code: 'pro' | 'studio'; current_period_end: Date }>(
        `UPDATE subscriptions
            SET status = 'canceled', cancel_at_period_end = true, updated_at = now()
          WHERE provider = $1 AND provider_subscription_id = $2
          RETURNING user_id, plan_code, current_period_end`,
        [providerName, evt.providerSubscriptionId],
      );
      const row = res.rows[0];
      const userId = row?.user_id ?? evt.userId;
      if (userId) invalidateEntitlement(userId);
      // V3-M2 — subscription-changed (canceled).
      if (userId) {
        await emailBestEffort('subscription_changed:canceled', () =>
          sendSubscriptionChanged(userId, {
            plan_code: row?.plan_code ?? 'pro',
            status: 'canceled',
            period_end: row?.current_period_end ?? null,
            provider_subscription_id: evt.providerSubscriptionId,
          }),
        );
      }
      return;
    }

    case 'invoice_paid': {
      // HIGH #1 FIX: Stripe does NOT populate `invoice.metadata.user_id` on
      // RECURRING invoices — only on the FIRST invoice created from the
      // Checkout session. On cycle rollover, evt.userId is '' and the old
      // code early-returned, so entitlement period never refreshed and the
      // user lost access at period end. Resolve via the subscription record
      // we already persisted (subscriptions.provider_subscription_id → user_id)
      // before giving up.
      let userId = evt.userId;
      if (!userId) {
        const res = await db.query<{ user_id: string }>(
          `SELECT user_id FROM subscriptions
            WHERE provider = $1 AND provider_subscription_id = $2`,
          [providerName, evt.providerSubscriptionId],
        );
        userId = res.rows[0]?.user_id ?? '';
      }
      if (!userId) {
        console.warn(
          `[webhook] invoice_paid: could not resolve user for sub ${evt.providerSubscriptionId}`,
        );
        return;
      }
      // Reload the subscription to recompute entitlement period. Falls back
      // to extending the existing period by the invoice interval.
      let planLabel = 'stem-loops subscription';
      try {
        const provider = getBillingProvider();
        const sub = await provider.getSubscription(evt.providerSubscriptionId);
        await upsertEntitlementFromSubscription(userId, sub);
        planLabel = `${sub.planCode} plan renewal`;
      } catch (err) {
        // B2 (credit-ledger review 2026-11-03): do NOT swallow. A 200 here
        // tells Stripe not to retry, so entitlements.period_end never
        // advances and the subscriber silently falls back to free. Re-throw
        // so the outer POST catch returns 500 and Stripe retries.
        console.error('[webhook] invoice_paid refresh failed:', err instanceof Error ? err.message : err);
        throw err;
      }
      invalidateEntitlement(userId);
      // V3-M3 — receipt for subscription renewal. Idempotency key is the
      // Stripe invoice id; a retried invoice.paid can't double-send the
      // receipt.
      await emailBestEffort('receipt:invoice_paid', () =>
        sendReceipt(userId, {
          amount_cad_cents: evt.invoice.amountCents,
          plan_or_pack_label: planLabel,
          invoice_url: evt.invoice.hostedInvoiceUrl,
          receipt_source: { kind: 'subscription', invoice_id: evt.invoice.providerInvoiceId },
        }),
      );
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

    case 'refund_created': {
      // M4 (credit-ledger review 2026-11-03): claw back credits for a refunded
      // credit purchase. credit_purchases.provider_charge_id holds the
      // PaymentIntent id, so match on the charge id OR its payment_intent.
      if (!evt.fullyRefunded) {
        // Partial refund: no pro-rata policy yet; leave credits, flag for support.
        console.warn(`[webhook] refund_created: partial refund on ${evt.providerChargeId}; no clawback`);
        return;
      }
      const ids = [evt.providerChargeId, evt.providerPaymentIntentId].filter(
        (x): x is string => !!x,
      );
      const found = await db.query<{ user_id: string; provider_charge_id: string; credits_granted: number }>(
        `SELECT user_id, provider_charge_id, credits_granted
           FROM credit_purchases
          WHERE provider = $1 AND provider_charge_id = ANY($2::text[])
          LIMIT 1`,
        [providerName, ids],
      );
      const purchase = found.rows[0];
      if (!purchase) {
        // Subscription invoice or non-credit charge: nothing to claw back.
        console.info(`[webhook] refund_created: no credit purchase for charge ${evt.providerChargeId}; ignoring`);
        return;
      }
      // Idempotent on (provider, provider_event_id) for Stripe retries and on
      // the partial unique (provider, provider_charge_id) WHERE reason='refund'
      // for a second distinct event on the same charge.
      const ins = await db.query(
        `INSERT INTO credit_adjustments
           (user_id, credits_delta, reason, provider, provider_event_id, provider_charge_id)
         VALUES ($1, $2, 'refund', $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          purchase.user_id,
          -Math.abs(purchase.credits_granted | 0),
          providerName,
          evt.providerEventId,
          purchase.provider_charge_id,
        ],
      );
      if ((ins.rowCount ?? 0) > 0) {
        await db.query(
          `INSERT INTO usage_events (user_id, kind, detail)
           VALUES ($1, 'refund_processed', $2::jsonb)`,
          [
            purchase.user_id,
            JSON.stringify({
              provider_event_id: evt.providerEventId,
              provider_charge_id: purchase.provider_charge_id,
              credits_clawed_back: purchase.credits_granted,
            }),
          ],
        );
        invalidateEntitlement(purchase.user_id);
      }
      return;
    }

    case 'dispute_created':
    case 'unhandled':
    default:
      // No-op: disputes are recorded by Stripe Dashboard and don't alter
      // entitlements yet. (Refunds are handled above — M4.)
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
