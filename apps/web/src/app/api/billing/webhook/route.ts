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
//   500 — DB write failure, OR money was taken but the payer could not be
//         resolved to a user (Stripe must retry; never ack a paid event we
//         did not fulfil)
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
import { computeProRataClawback } from '@/lib/billing/prorata';
import {
  sendPaymentFailed,
  sendPlanEnded,
  sendPlanEnding,
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

/** The stored subscription row before this event's upsert/update. */
type StoredSub = { status: string; plan_code: string; cancel_at_period_end: boolean };

/** Read the stored row for a subscription BEFORE this event changes it, so the
 *  email branching can compare old and new (emails v1.2 §3 R4). A failed read
 *  returns { known: false } and the caller sends no change email: an email
 *  must never be a reason for Stripe to retry a fulfilment. */
async function readStoredSub(
  providerName: string,
  providerSubscriptionId: string,
): Promise<{ known: boolean; row: StoredSub | null }> {
  try {
    const res = await db.query<StoredSub>(
      `SELECT status, plan_code, cancel_at_period_end FROM subscriptions
        WHERE provider = $1 AND provider_subscription_id = $2`,
      [providerName, providerSubscriptionId],
    );
    return { known: true, row: res.rows[0] ?? null };
  } catch (err) {
    console.error('[webhook] stored subscription read failed:', err instanceof Error ? err.message : err);
    return { known: false, row: null };
  }
}

type SubEmailCase =
  | { kind: 'active'; resumed: boolean }
  | { kind: 'switched'; previous: 'pro' | 'studio' }
  | { kind: 'paused' }
  | { kind: 'ending' }
  | null;

/** Which email (if any) a subscription_upserted sends, beyond R2
 *  (emails v1.2 §3 R4; fixes E2 and E3):
 *    R4 "active"       no stored row, or a stored `incomplete` row, now
 *                      active/trialing, and R2 did not go out in this event
 *                      (a re-subscriber who was welcomed before);
 *    R5 "ending"       cancel_at_period_end went false -> true;
 *    R4 "switched"     plan changed while active;
 *    R4 "paused"       status became paused;
 *    R4 "active again" paused or past_due -> active;
 *    otherwise nothing: a renewal (R3 covers it), `incomplete`, `past_due`
 *    (R7), `canceled` (R6), or a first activation that R2 already covered. */
function subscriptionEmailCase(
  prev: StoredSub | null,
  next: { status: string; planCode: 'pro' | 'studio'; cancelAtPeriodEnd: boolean },
  welcomeSent: boolean,
): SubEmailCase {
  const nowActive = next.status === 'active' || next.status === 'trialing';
  if ((!prev || prev.status === 'incomplete') && nowActive) {
    return welcomeSent || next.cancelAtPeriodEnd ? null : { kind: 'active', resumed: false };
  }
  if (!prev) return null;
  if (!prev.cancel_at_period_end && next.cancelAtPeriodEnd && nowActive) return { kind: 'ending' };
  if (
    next.status === 'active' &&
    prev.plan_code !== next.planCode &&
    (prev.plan_code === 'pro' || prev.plan_code === 'studio')
  ) {
    return { kind: 'switched', previous: prev.plan_code };
  }
  if (next.status === 'paused' && prev.status !== 'paused') return { kind: 'paused' };
  if (next.status === 'active' && (prev.status === 'paused' || prev.status === 'past_due')) {
    return { kind: 'active', resumed: true };
  }
  return null;
}

/** True when some subscription of the user's still entitles them. */
async function hasLiveSubscription(userId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM subscriptions
      WHERE user_id = $1 AND status IN ('active','trialing','past_due') LIMIT 1`,
    [userId],
  );
  return (res.rowCount ?? res.rows.length) > 0;
}

/** Thrown when money was taken but we cannot tell whose it is. The route turns
 *  any throw into a 500 so Stripe retries and the failure is loud; returning
 *  200 here would silently abandon a paid purchase. */
class UnresolvedPayerError extends Error {
  constructor(what: string, detail: Record<string, unknown>) {
    super(`${what}: cannot resolve user (${JSON.stringify(detail)})`);
    this.name = 'UnresolvedPayerError';
  }
}

/** Resolve the owning user for a billing event. Order: explicit metadata
 *  user_id, then customers_billing by provider customer id (the row checkout
 *  stores before creating a session), then the subscriptions row, then a
 *  matching users.email as a last resort. Returns '' when nothing matches. */
async function resolveUserId(
  providerName: string,
  hint: {
    userId?: string | null;
    customerId?: string | null;
    subscriptionId?: string | null;
    email?: string | null;
  },
): Promise<string> {
  if (hint.userId) return hint.userId;
  if (hint.customerId) {
    const res = await db.query<{ user_id: string }>(
      `SELECT user_id FROM customers_billing
        WHERE provider = $1 AND provider_customer_id = $2`,
      [providerName, hint.customerId],
    );
    if (res.rows[0]?.user_id) return res.rows[0].user_id;
  }
  if (hint.subscriptionId) {
    const res = await db.query<{ user_id: string }>(
      `SELECT user_id FROM subscriptions
        WHERE provider = $1 AND provider_subscription_id = $2`,
      [providerName, hint.subscriptionId],
    );
    if (res.rows[0]?.user_id) return res.rows[0].user_id;
  }
  if (hint.email) {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [hint.email],
    );
    if (res.rows[0]?.id) return res.rows[0].id;
  }
  return '';
}

/** Drop a user's paid entitlement to free, unless another subscription of
 *  theirs still entitles them. Callers must have already persisted the new
 *  (canceled / paused) subscription status. */
async function downgradeEntitlementIfUnentitled(userId: string): Promise<void> {
  await db.query(
    `UPDATE entitlements
        SET plan_code = 'free', computed_at = now()
      WHERE user_id = $1
        AND plan_code <> 'free'
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions
           WHERE user_id = $1 AND status IN ('active','trialing','past_due'))`,
    [userId],
  );
}

/** Recompute the entitlements row from the authoritative subscription state.
 *  Called on subscription_upserted and invoice_paid events.
 *    active / trialing -> grant/refresh the paid plan
 *    canceled / paused -> downgrade to free
 *    past_due          -> leave the row; readSnapshot applies the grace window
 *    incomplete        -> never paid; grant nothing */
async function upsertEntitlementFromSubscription(
  userId: string,
  sub: BillingSubscription,
): Promise<void> {
  const planCode = dbPlanCode(sub.planCode);
  if (!planCode) return;
  if (sub.status === 'canceled' || sub.status === 'paused') {
    await downgradeEntitlementIfUnentitled(userId);
    return;
  }
  if (sub.status !== 'active' && sub.status !== 'trialing') return;
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

/** Claw back credits for a refunded or disputed credit purchase. Shared by
 *  refund_created and dispute_created so both draw on the same per-charge
 *  'refund' ledger and can never claw back more than was granted. Idempotent
 *  on (provider, provider_event_id). */
async function clawBackCreditPurchase(
  providerName: string,
  evt: {
    label: string;
    providerEventId: string;
    providerChargeId: string;
    providerPaymentIntentId: string | null;
    fullyRefunded: boolean;
    amountRefunded: number;
  },
): Promise<void> {
  // M4 (credit-ledger review 2026-11-03): claw back credits for a refunded
  // credit purchase. credit_purchases.provider_charge_id holds the
  // PaymentIntent id, so match on the charge id OR its payment_intent.
  const ids = [evt.providerChargeId, evt.providerPaymentIntentId].filter(
    (x): x is string => !!x,
  );
  const found = await db.query<{
    user_id: string;
    provider_charge_id: string;
    credits_granted: number;
    amount_cad_cents: number;
  }>(
    `SELECT user_id, provider_charge_id, credits_granted, amount_cad_cents
       FROM credit_purchases
      WHERE provider = $1 AND provider_charge_id = ANY($2::text[])
      LIMIT 1`,
    [providerName, ids],
  );
  const purchase = found.rows[0];
  if (!purchase) {
    // Subscription invoice or non-credit charge: nothing to claw back.
    console.info(`[webhook] ${evt.label}: no credit purchase for charge ${evt.providerChargeId}; ignoring`);
    return;
  }
  // Pro-rata (M4 follow-up, Option A): total clawed back so far for this
  // charge; this event claws back only the delta. Full refunds close any
  // floor() residual. Net <= 0 => no-op (Stripe retries, stale events).
  // The SUM + INSERT run in one tx under a per-charge advisory lock so two
  // concurrent charge.refunded events (distinct event ids) serialise and
  // the second sees the first's row. Same lock-then-write shape as
  // consumeCreditInTx (lib/billing/credits.ts).
  const chargeId = purchase.provider_charge_id;
  const outcome = await db.tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('refund_clawback:' || $1::text))`,
      [chargeId],
    );
    const prior = await client.query<{ clawed: number | string }>(
      `SELECT COALESCE(SUM(-credits_delta), 0) AS clawed
         FROM credit_adjustments
        WHERE provider = $1 AND provider_charge_id = $2 AND reason = 'refund'`,
      [providerName, chargeId],
    );
    const alreadyClawed = Number(prior.rows[0]?.clawed ?? 0) | 0;
    const toClaw = computeProRataClawback({
      amountRefunded: evt.amountRefunded,
      amountTotal: purchase.amount_cad_cents,
      creditsGranted: purchase.credits_granted,
      alreadyClawed,
      isFullRefund: evt.fullyRefunded,
    });
    if (toClaw <= 0) return { alreadyClawed, toClaw, inserted: false };
    // Idempotent on (provider, provider_event_id) for Stripe retries. Several
    // refund rows per charge are legal (migration 024 drops the
    // one-per-charge unique index); the locked SUM above bounds the total.
    const ins = await client.query(
      `INSERT INTO credit_adjustments
         (user_id, credits_delta, reason, provider, provider_event_id, provider_charge_id)
       VALUES ($1, $2, 'refund', $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [purchase.user_id, -toClaw, providerName, evt.providerEventId, chargeId],
    );
    const inserted = (ins.rowCount ?? 0) > 0;
    if (inserted) {
      await client.query(
        `INSERT INTO usage_events (user_id, kind, detail)
         VALUES ($1, 'refund_processed', $2::jsonb)`,
        [
          purchase.user_id,
          JSON.stringify({
            provider_event_id: evt.providerEventId,
            provider_charge_id: chargeId,
            credits_clawed_back: toClaw,
            total_clawed_back: alreadyClawed + toClaw,
            partial: !evt.fullyRefunded,
            source: evt.label,
          }),
        ],
      );
    }
    return { alreadyClawed, toClaw, inserted };
  });
  if (outcome.toClaw <= 0) {
    console.info(
      `[webhook] ${evt.label}: nothing to claw back on ${evt.providerChargeId} (already ${outcome.alreadyClawed})`,
    );
    return;
  }
  if (outcome.inserted) invalidateEntitlement(purchase.user_id);
}

async function handleBillingEvent(evt: BillingEvent, providerName: 'stripe' | 'paddle'): Promise<void> {
  switch (evt.type) {
    case 'credit_purchase_completed': {
      // Money has been taken. NEVER drop this with a 200: resolve the payer
      // (metadata -> session.customer -> customer_email) or throw so Stripe
      // retries and the failure is loud.
      const payerId = await resolveUserId(providerName, {
        userId: evt.userId,
        customerId: evt.providerCustomerId,
        email: evt.customerEmail,
      });
      if (!payerId) {
        console.error(
          `[webhook][UNFULFILLED PAYMENT] credit purchase ${evt.providerChargeId} (${evt.packCode}, ${evt.amountCents} ${evt.currency}) paid but no user resolvable; customer=${evt.providerCustomerId ?? 'none'} email=${evt.customerEmail ?? 'none'}. Returning 500 so Stripe retries.`,
        );
        throw new UnresolvedPayerError('credit_purchase_completed', {
          charge: evt.providerChargeId,
          customer: evt.providerCustomerId ?? null,
        });
      }
      // Defensive users-row upsert (round-1 MEDIUM): if the handle_new_user
      // trigger hasn't caught up, seed the row here so we actually grant
      // credits. On failure, this throws and the route returns 500 → Stripe
      // retries. Email hint comes from the Checkout Session.
      await ensureUserRow(payerId, evt.customerEmail ?? null);
      const credits = credits_for_pack(evt.packCode);
      await db.query(
        `INSERT INTO credit_purchases
           (user_id, provider, provider_charge_id, pack_code, credits_granted,
            amount_cad_cents, promo_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (provider, provider_charge_id) DO NOTHING`,
        [
          payerId,
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
          [payerId, evt.promoCode, evt.promoCodeId ?? null],
        );
      }
      invalidateEntitlement(payerId);
      // V3-M3 — receipt for one-time credit purchase. Idempotency key is
      // the Stripe charge / payment-intent id (stable across retries), so a
      // double-delivered webhook can't double-send the receipt.
      await emailBestEffort('receipt:credit_purchase', () =>
        sendReceipt(payerId, {
          amount_cad_cents: evt.amountCents,
          plan_or_pack_label: `${credits} credits`,
          invoice_url: null,
          paid_on: new Date(),
          receipt_source: { kind: 'credit', provider_charge_id: evt.providerChargeId },
        }),
      );
      return;
    }

    case 'subscription_upserted': {
      // subscription_data.metadata.user_id is the primary key; fall back to
      // the stored customer for subscriptions created without it. Unresolved
      // => throw (500, Stripe retries) rather than silently abandon a payer.
      const subUserId = await resolveUserId(providerName, {
        userId: evt.userId,
        customerId: evt.subscription.providerCustomerId,
        subscriptionId: evt.subscription.providerSubscriptionId,
      });
      if (!subUserId) {
        console.error(
          `[webhook][UNFULFILLED SUBSCRIPTION] ${evt.subscription.providerSubscriptionId} (${evt.subscription.status}) has no user_id metadata and customer ${evt.subscription.providerCustomerId} is not in customers_billing. Returning 500 so Stripe retries.`,
        );
        throw new UnresolvedPayerError('subscription_upserted', {
          subscription: evt.subscription.providerSubscriptionId,
          customer: evt.subscription.providerCustomerId,
        });
      }
      // Defensive users-row upsert; throws on failure so Stripe retries.
      await ensureUserRow(subUserId, null);
      const planCode = dbPlanCode(evt.subscription.planCode);
      if (!planCode) return;
      // customers_billing must exist for the FK story; insert idempotently.
      await db.query(
        `INSERT INTO customers_billing (user_id, provider, provider_customer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, provider) DO NOTHING`,
        [subUserId, providerName, evt.subscription.providerCustomerId],
      );
      // The row as it was before this event, for the email branching below.
      const stored = await readStoredSub(providerName, evt.subscription.providerSubscriptionId);
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
          subUserId,
          providerName,
          evt.subscription.providerSubscriptionId,
          planCode,
          evt.subscription.status,
          evt.subscription.currentPeriodStart ?? new Date(),
          evt.subscription.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
          evt.subscription.cancelAtPeriodEnd,
        ],
      );
      await upsertEntitlementFromSubscription(subUserId, evt.subscription);
      invalidateEntitlement(subUserId);
      // Emails (emails v1.2 R2, R4, R5). R2, the welcome, goes out only once
      // the plan is actually active or trialing: never on `incomplete`, which
      // grants nothing (E3). It is idempotent via users.welcomed_at.
      const sub = evt.subscription;
      const nowActive = sub.status === 'active' || sub.status === 'trialing';
      let welcomeSent = false;
      if (nowActive) {
        await emailBestEffort('welcome:first_time', async () => {
          welcomeSent = await sendWelcomeIfFirstTime(subUserId, {
            plan_code: planCode,
            period_end: sub.currentPeriodEnd,
          });
        });
      }
      if (!stored.known) return;
      const change = subscriptionEmailCase(
        stored.row,
        { status: sub.status, planCode, cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
        welcomeSent,
      );
      if (!change) return;
      if (change.kind === 'ending') {
        await emailBestEffort('plan_ending', () =>
          sendPlanEnding(subUserId, {
            plan_code: planCode,
            period_end: sub.currentPeriodEnd,
            provider_subscription_id: sub.providerSubscriptionId,
          }),
        );
        return;
      }
      await emailBestEffort(`subscription_changed:${change.kind}`, () =>
        sendSubscriptionChanged(subUserId, {
          plan_code: planCode,
          status: change.kind === 'paused' ? 'paused' : sub.status === 'trialing' ? 'trialing' : 'active',
          period_end: sub.currentPeriodEnd,
          provider_subscription_id: sub.providerSubscriptionId,
          previous_plan_code: change.kind === 'switched' ? change.previous : null,
          resumed: change.kind === 'active' ? change.resumed : false,
        }),
      );
      return;
    }

    case 'subscription_canceled': {
      // Mark the row canceled and downgrade the entitlement. Stripe sends
      // customer.subscription.deleted when the paid period has ended (or on an
      // immediate cancel), so access ends now. readSnapshot also gates on
      // subscription status, so a stale 'pro' row can never outlive this.
      const stored = await readStoredSub(providerName, evt.providerSubscriptionId);
      const res = await db.query<{ user_id: string; plan_code: 'pro' | 'studio'; current_period_end: Date }>(
        `UPDATE subscriptions
            SET status = 'canceled', cancel_at_period_end = true, updated_at = now()
          WHERE provider = $1 AND provider_subscription_id = $2
          RETURNING user_id, plan_code, current_period_end`,
        [providerName, evt.providerSubscriptionId],
      );
      const row = res.rows[0];
      const userId =
        row?.user_id ??
        (await resolveUserId(providerName, {
          userId: evt.userId,
          customerId: evt.providerCustomerId,
        }));
      if (userId) {
        await downgradeEntitlementIfUnentitled(userId);
        invalidateEntitlement(userId);
      }
      // R6, plan ended (emails v1.2; fixes E1). Sent only when we know which
      // plan ended (a stored row) and it was a plan the user actually had: a
      // subscription that was still `incomplete` never granted anything, and
      // one already stored as `canceled` was ended by an earlier event (for
      // example Stripe's incomplete_expired, mapped to canceled, which never
      // granted a plan either). The old code guessed 'pro' when the row was
      // missing and told the user they would keep access until period end.
      const prevStatus = stored.row?.status;
      if (
        userId &&
        row &&
        stored.known &&
        prevStatus !== undefined &&
        prevStatus !== 'incomplete' &&
        prevStatus !== 'canceled'
      ) {
        await emailBestEffort('plan_ended', async () => {
          const stillEntitled = await hasLiveSubscription(userId);
          await sendPlanEnded(userId, {
            plan_code: row.plan_code,
            period_end: row.current_period_end ?? null,
            provider_subscription_id: evt.providerSubscriptionId,
            on_free: !stillEntitled,
          });
        });
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
      const userId = await resolveUserId(providerName, {
        userId: evt.userId,
        subscriptionId: evt.providerSubscriptionId,
        customerId: evt.providerCustomerId,
      });
      if (!userId) {
        // A paid invoice we cannot attribute. Do not ack with 200.
        console.error(
          `[webhook][UNFULFILLED PAYMENT] invoice ${evt.invoice.providerInvoiceId} (${evt.invoice.amountCents} ${evt.invoice.currency}) paid for sub ${evt.providerSubscriptionId} but no user resolvable. Returning 500 so Stripe retries.`,
        );
        throw new UnresolvedPayerError('invoice_paid', {
          invoice: evt.invoice.providerInvoiceId,
          subscription: evt.providerSubscriptionId,
        });
      }
      // Reload the subscription to recompute entitlement period. Falls back
      // to extending the existing period by the invoice interval.
      let planLabel = 'stem-loops subscription';
      try {
        const provider = getBillingProvider();
        const sub = await provider.getSubscription(evt.providerSubscriptionId);
        await upsertEntitlementFromSubscription(userId, sub);
        // E4: only a cycle invoice is a "renewal". The first invoice
        // (subscription_create) and anything else is labelled "<Plan> plan".
        const planName = ({ pro: 'Pro', studio: 'Studio' } as Record<string, string>)[sub.planCode] ?? sub.planCode;
        planLabel = evt.billingReason === 'subscription_cycle' ? `${planName} plan renewal` : `${planName} plan`;
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
          paid_on: evt.invoice.paidAt,
          receipt_source: { kind: 'subscription', invoice_id: evt.invoice.providerInvoiceId },
        }),
      );
      return;
    }

    case 'invoice_payment_failed': {
      // Flip the subscription to past_due. Access continues for the grace
      // window (PAST_DUE_GRACE_MS, applied by readSnapshot) and then drops to
      // free; the entitlement row itself is left alone.
      const res = await db.query<{
        user_id: string;
        plan_code: 'pro' | 'studio';
        current_period_start: Date | string | null;
      }>(
        `UPDATE subscriptions SET status = 'past_due', updated_at = now()
          WHERE provider = $1 AND provider_subscription_id = $2
          RETURNING user_id, plan_code, current_period_start`,
        [providerName, evt.providerSubscriptionId],
      );
      const failedRow = res.rows[0];
      const failedUser = failedRow?.user_id ?? evt.userId;
      if (failedUser) invalidateEntitlement(failedUser);
      // R7, payment failed (emails v1.2; fixes E5). Only for a renewal or a
      // mid-period plan change, and only when a stored subscription matched.
      // A failed FIRST payment (subscription_create) sends nothing: the user
      // is still in Checkout and never had the plan.
      const reason = evt.billingReason ?? null;
      if (reason !== 'subscription_cycle' && reason !== 'subscription_update') {
        console.info(
          `[webhook] invoice_payment_failed ${evt.providerInvoiceId ?? '?'}: no email (billing_reason=${reason ?? 'none'})`,
        );
        return;
      }
      if (!failedRow || !evt.providerInvoiceId) return;
      const periodStart = evt.periodStart ?? failedRow.current_period_start;
      if (!periodStart) return;
      await emailBestEffort('payment_failed', () =>
        sendPaymentFailed(failedRow.user_id, {
          plan_code: failedRow.plan_code,
          period_start: periodStart,
          next_attempt: evt.nextPaymentAttempt ?? null,
          provider_invoice_id: evt.providerInvoiceId as string,
          attempt_count: evt.attemptCount ?? 0,
        }),
      );
      return;
    }

    case 'refund_created': {
      await clawBackCreditPurchase(providerName, {
        label: 'refund_created',
        providerEventId: evt.providerEventId,
        providerChargeId: evt.providerChargeId,
        providerPaymentIntentId: evt.providerPaymentIntentId,
        fullyRefunded: evt.fullyRefunded,
        amountRefunded: evt.amountRefunded,
      });
      return;
    }

    case 'dispute_created': {
      // A chargeback must not leave the user holding the credits. Disputes
      // are clawed back in full through the same ledger as refunds, keyed on
      // the dispute event id (idempotent on Stripe retries). A later won
      // dispute does not re-grant credits; that is a manual adjustment.
      await clawBackCreditPurchase(providerName, {
        label: 'dispute_created',
        providerEventId: evt.providerEventId,
        providerChargeId: evt.providerChargeId,
        providerPaymentIntentId: evt.providerPaymentIntentId,
        fullyRefunded: true,
        amountRefunded: 0,
      });
      return;
    }

    case 'unhandled':
    default:
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
