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
// Ordering (QA B-04): Stripe neither orders nor de-duplicates deliveries.
// Subscription events and invoice.payment_failed re-read the subscription
// from Stripe and apply its CURRENT state, never the payload; a stored
// `canceled` row is terminal.
// Credit packs are priced from the session's line items, never its metadata.
//
// Raw body: we MUST use req.text() (Next 14 App Router) — JSON parsing
// would normalize whitespace and invalidate the signature.

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getBillingProvider, type BillingEvent, type BillingSubscription } from '@/lib/billing';
import type { BillingSubscriptionChange } from '@/lib/billing/types';
// The webhook's OWN pool (PR #298 review R2-2): it holds a transaction across
// a Stripe read, so it must never take the connections page loads use.
import { webhookDb as db } from '@/lib/db';
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

// Time budget (PR #298 review R2-2, R3-2). Every wait on this path is
// bounded, and the bounds add up to well under maxDuration, so the function
// returns (500, Stripe retries) before Vercel kills it. One Stripe read is
// STRIPE_WEBHOOK_READ_OPTIONS.timeout (6 s) per attempt, and stripe-node
// retries once on a connection reset even with retries off, so a read can
// take 2 x 6 = 12 s:
//   Stripe read outside the lock (credit session, or the L-4 re-read)  12 s
//   webhook-pool connection (WEBHOOK_POOL_CONNECT_TIMEOUT_MS, db.ts)    5 s
//   advisory-lock wait (LOCK_TIMEOUT)                                   8 s
//   Stripe reads inside the lock (subscription + invoice), 12 s each   24 s
//                                                              total  49 s
// leaving 11 s for the (millisecond) statements, each capped by
// STATEMENT_TIMEOUT, and the best-effort emails after commit.
export const maxDuration = 60;
const LOCK_TIMEOUT = '8s';
const STATEMENT_TIMEOUT = '10s';
// Longer than the longest gap between two statements of the locked
// transaction: one Stripe read including the SDK's forced reset retry
// (2 x 6 s = 12 s; 20 s would also cover 2 x 8 s). A frozen instance's open
// transaction (and its advisory lock) is then ended by the server after this.
const IDLE_IN_TX_TIMEOUT = '20s';

// PR #29 aligned BillingProvider's PlanCode with plans.code ('free' | 'pro' |
// 'studio'), so no translation is needed anymore. We just narrow 'free' out,
// which is not a valid subscription plan (TSD §1.2).
/** db, or the client of a db.tx. Everything inside a subscription lock must
 *  use the tx client: the pool is max 3, so a second checkout from inside a
 *  held transaction can deadlock the pool under concurrent webhooks. */
type Queryable = { query: typeof db.query };

/** Raise a money-path problem to Sentry (and the log) without failing the
 *  request: used where Stripe must get 200 but a human must look. */
function alertBilling(message: string, extra: Record<string, unknown>): void {
  console.error(`[webhook][ALERT] ${message}`, JSON.stringify(extra));
  try {
    Sentry.captureMessage(message, { level: 'error', tags: { route: 'api/billing/webhook' }, extra });
  } catch {
    // never let reporting break the webhook
  }
}

/** QA B-04 / review M-1. Run `fn` in ONE transaction holding a
 *  per-subscription advisory lock. The provider read happens INSIDE `fn`,
 *  i.e. after any earlier delivery for the same subscription committed, so
 *  an older read can never be written after a newer one. db.tx checks out a
 *  single client and wraps BEGIN/COMMIT; pg_advisory_xact_lock is
 *  transaction-scoped, so it is safe behind a transaction-mode pooler
 *  (DATABASE_URL_POOLED) where a session lock would not be. The SET LOCALs
 *  bound the lock wait, every statement, and idle time inside the
 *  transaction (review R2-2): a stuck holder is a 500 (Stripe retries), not
 *  a hang. */
async function withSubscriptionLock<T>(
  providerName: string,
  providerSubscriptionId: string,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  return db.tx(async (q) => {
    await q.query(
      `SELECT set_config('lock_timeout', $1, true),
              set_config('statement_timeout', $2, true),
              set_config('idle_in_transaction_session_timeout', $3, true)`,
      [LOCK_TIMEOUT, STATEMENT_TIMEOUT, IDLE_IN_TX_TIMEOUT],
    );
    await q.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || '-sub:' || $2, 0))`,
      [providerName, providerSubscriptionId],
    );
    return fn(q);
  });
}

/** The provider's CURRENT state of a subscription, or null when it carries a
 *  price/status we cannot map (alerted, then dropped: Stripe gets 200). Any
 *  other failure throws, so the route answers 500 and Stripe retries. */
async function readCurrentSubscription(
  label: string,
  providerSubscriptionId: string,
): Promise<BillingSubscription | null> {
  let current: BillingSubscription;
  try {
    current = await getBillingProvider().getSubscription(providerSubscriptionId);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'UnknownPriceError' || name === 'UnknownStatusError') {
      alertBilling(`${label}: subscription dropped, unmappable current state`, {
        subscription: providerSubscriptionId,
        error: (err as Error).message,
      });
      return null;
    }
    throw err;
  }
  if (current.providerSubscriptionId !== providerSubscriptionId) {
    throw new Error(
      `${label}: provider returned ${current.providerSubscriptionId} for ${providerSubscriptionId}`,
    );
  }
  return current;
}

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
async function ensureUserRow(
  userId: string,
  emailHint?: string | null,
  q: Queryable = db,
): Promise<void> {
  // Fast-path: row already exists.
  const read = await q.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if ((read.rowCount ?? 0) > 0) return;

  // Try to recover an email from auth.users first (the webhook role has
  // SELECT via the handle_new_user trigger's SECURITY DEFINER path in most
  // deployments, but may not in all — tolerate failure).
  let email = emailHint ?? null;
  if (!email) {
    // Inside a transaction a failed statement aborts the WHOLE transaction,
    // so the tolerated failure is fenced by a savepoint.
    const inTx = q !== db;
    try {
      if (inTx) await q.query('SAVEPOINT ensure_user_auth_read');
      const auth = await q.query<{ email: string | null }>(
        'SELECT email FROM auth.users WHERE id = $1',
        [userId],
      );
      email = auth.rows[0]?.email ?? null;
      if (inTx) await q.query('RELEASE SAVEPOINT ensure_user_auth_read');
    } catch {
      // auth schema not readable from this role; keep going with derived email
      if (inTx) await q.query('ROLLBACK TO SAVEPOINT ensure_user_auth_read');
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
  await q.query(
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

/** A subscription's state before an event: status, plan, cancel flag. */
type StoredSub = { status: string; plan_code: string; cancel_at_period_end: boolean };

/** The state BEFORE a subscription_upserted, derived from the event itself
 *  (Stripe `previous_attributes`), never from our stored row. Why: the stored
 *  row is overwritten by the upsert, so if a later step in this handler throws
 *  and Stripe retries, a stored-row comparison sees "no change" and the email
 *  is lost for good (PR #272 review B2). The event is identical on every
 *  retry, so the same email is derived every time, and the per-transition
 *  Resend idempotency key stops a second send. Emails go out only after every
 *  DB write in the handler, so a delivery that already sent also returned 200.
 *  null = a new subscription (customer.subscription.created). */
function previousFromEvent(
  previous: BillingSubscriptionChange | null | undefined,
  now: { status: string; plan_code: string; cancel_at_period_end: boolean },
): StoredSub | null {
  if (previous === null) return null;
  const p = previous ?? {};
  return {
    status: p.status ?? now.status,
    plan_code: p.planCode ?? now.plan_code,
    cancel_at_period_end: p.cancelAtPeriodEnd ?? now.cancel_at_period_end,
  };
}

/** Read the stored row for a subscription before subscription_canceled
 *  changes it. A failed read returns { known: false }: an email must never
 *  be a reason for Stripe to retry a fulfilment. */
async function readStoredSub(
  providerName: string,
  providerSubscriptionId: string,
  q: Queryable = db,
): Promise<{ known: boolean; row: StoredSub | null }> {
  try {
    const res = await q.query<StoredSub>(
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

/** True when this user's welcome (R2) was already sent for THIS
 *  subscription: users.welcomed_at is at or after the subscription's
 *  creation. A redelivered first-activation event (Stripe can deliver an
 *  event more than once) then re-derives "first activation" with
 *  welcomeSent=false, because the first delivery already set welcomed_at;
 *  without this check it would send R4 "Your plan is active" right after the
 *  welcome, under a different Resend key (PR #272 review-2 B3). A re-subscriber
 *  welcomed before this subscription existed still gets R4. Unknown (no
 *  creation time, read failed) counts as welcomed: a missed R4 is harmless,
 *  R3 confirms the plan anyway, while a duplicate is visible. */
async function welcomedForSubscription(userId: string, createdAt: Date | null | undefined): Promise<boolean> {
  if (!createdAt) return true;
  try {
    const res = await db.query<{ welcomed_at: Date | string | null }>(
      'SELECT welcomed_at FROM users WHERE id = $1',
      [userId],
    );
    const w = res.rows[0]?.welcomed_at;
    if (!w) return false;
    return new Date(w).getTime() >= createdAt.getTime();
  } catch (err) {
    console.error('[webhook] welcomed_at read failed:', err instanceof Error ? err.message : err);
    return true;
  }
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
  q: Queryable = db,
): Promise<string> {
  if (hint.userId) return hint.userId;
  if (hint.customerId) {
    const res = await q.query<{ user_id: string }>(
      `SELECT user_id FROM customers_billing
        WHERE provider = $1 AND provider_customer_id = $2`,
      [providerName, hint.customerId],
    );
    if (res.rows[0]?.user_id) return res.rows[0].user_id;
  }
  if (hint.subscriptionId) {
    const res = await q.query<{ user_id: string }>(
      `SELECT user_id FROM subscriptions
        WHERE provider = $1 AND provider_subscription_id = $2`,
      [providerName, hint.subscriptionId],
    );
    if (res.rows[0]?.user_id) return res.rows[0].user_id;
  }
  if (hint.email) {
    const res = await q.query<{ id: string }>(
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
async function downgradeEntitlementIfUnentitled(userId: string, q: Queryable = db): Promise<void> {
  await q.query(
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
  q: Queryable = db,
): Promise<void> {
  const planCode = dbPlanCode(sub.planCode);
  if (!planCode) return;
  if (sub.status === 'canceled' || sub.status === 'paused') {
    await downgradeEntitlementIfUnentitled(userId, q);
    return;
  }
  if (sub.status !== 'active' && sub.status !== 'trialing') return;
  const periodStart = sub.currentPeriodStart ?? new Date();
  const periodEnd = sub.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000);
  // Upsert entitlements; jobs_used resets to 0 on a new period.
  await q.query(
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
      // QA B-04: Stripe neither orders nor de-duplicates deliveries, and it
      // retries a failed one for days. Applying the event PAYLOAD let a stale
      // `updated (active)` retry, landing after `deleted`, turn a canceled
      // subscription and its Pro/Studio entitlement back on. So the payload
      // only names the subscription: its state is re-read from the provider
      // and THAT is applied. The read and the write run in ONE transaction
      // under a per-subscription advisory lock (review M-1), so two
      // concurrent deliveries cannot write an older read over a newer one.
      // A failed read throws (500, Stripe retries); an unmappable price or
      // status is alerted and dropped.
      const subId = evt.subscription.providerSubscriptionId;
      const applied = await withSubscriptionLock(providerName, subId, async (q) => {
        const current = await readCurrentSubscription('subscription_upserted', subId);
        if (!current) return null;
        // subscription_data.metadata.user_id is the primary key; fall back to
        // the stored customer for subscriptions created without it.
        // Unresolved => throw (500, Stripe retries) rather than silently
        // abandon a payer.
        const subUserId = await resolveUserId(
          providerName,
          {
            userId: evt.userId,
            customerId: current.providerCustomerId,
            subscriptionId: current.providerSubscriptionId,
          },
          q,
        );
        if (!subUserId) {
          console.error(
            `[webhook][UNFULFILLED SUBSCRIPTION] ${current.providerSubscriptionId} (${current.status}) has no user_id metadata and customer ${current.providerCustomerId} is not in customers_billing. Returning 500 so Stripe retries.`,
          );
          throw new UnresolvedPayerError('subscription_upserted', {
            subscription: current.providerSubscriptionId,
            customer: current.providerCustomerId,
          });
        }
        // A subscription that is already canceled at Stripe, for a user whose
        // account is gone (DELETE /api/users/me cancels, then the auth.users
        // cascade removes public.users), has nothing left to grant. Recreating
        // the users row would violate its FK to auth.users and 500 on every
        // retry for ~3 days (review R2-1), so ack it instead.
        if (current.status === 'canceled') {
          const exists = await q.query('SELECT 1 FROM users WHERE id = $1', [subUserId]);
          if ((exists.rowCount ?? exists.rows.length) === 0) {
            console.info(
              `[webhook] subscription_upserted ${current.providerSubscriptionId}: canceled, and user ${subUserId} no longer exists; nothing to apply`,
            );
            return null;
          }
        }
        // Defensive users-row upsert; throws on failure so Stripe retries.
        await ensureUserRow(subUserId, null, q);
        const planCode = dbPlanCode(current.planCode);
        if (!planCode) return null;
        // customers_billing must exist for the FK story; insert idempotently.
        await q.query(
          `INSERT INTO customers_billing (user_id, provider, provider_customer_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, provider) DO NOTHING`,
          [subUserId, providerName, current.providerCustomerId],
        );
        // `canceled` is terminal at Stripe: a canceled subscription id never
        // becomes active again. The WHERE makes it terminal here too, so a
        // stored canceled row (including the tombstone subscription_canceled
        // writes when it arrives first) can never be revived.
        const written = await q.query<{ status: string }>(
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
             updated_at           = now()
           WHERE subscriptions.status <> 'canceled'
           RETURNING status`,
          [
            subUserId,
            providerName,
            current.providerSubscriptionId,
            planCode,
            current.status,
            current.currentPeriodStart ?? new Date(),
            current.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
            current.cancelAtPeriodEnd,
          ],
        );
        if ((written.rowCount ?? written.rows.length) === 0) {
          // Stored row is already canceled: grant nothing, send nothing, and
          // make sure no paid entitlement survives it.
          console.warn(
            `[webhook] subscription_upserted ${current.providerSubscriptionId} (${current.status}) ignored: stored subscription is canceled`,
          );
          await downgradeEntitlementIfUnentitled(subUserId, q);
          return { subUserId, current, planCode, blocked: true as const };
        }
        await upsertEntitlementFromSubscription(subUserId, current, q);
        return { subUserId, current, planCode, blocked: false as const };
      });
      if (!applied) return;
      const { subUserId, planCode } = applied;
      invalidateEntitlement(subUserId);
      if (applied.blocked) return;
      // Emails run AFTER commit (never while holding the lock). R2, the
      // welcome, goes out only once the plan is actually active or trialing:
      // never on `incomplete`, which grants nothing (E3). It is idempotent
      // via users.welcomed_at. The transition (`previous`) still comes from
      // the event, but it is judged against the CURRENT state, so a stale
      // event cannot announce a change that has since been undone.
      const sub = applied.current;
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
      const before = previousFromEvent(evt.previous, {
        status: sub.status,
        plan_code: planCode,
        cancel_at_period_end: sub.cancelAtPeriodEnd,
      });
      const change = subscriptionEmailCase(
        before,
        { status: sub.status, planCode, cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
        welcomeSent,
      );
      if (!change) return;
      if (
        change.kind === 'active' &&
        !change.resumed &&
        (await welcomedForSubscription(subUserId, sub.createdAt))
      ) {
        return;
      }
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
      // Not re-read from the provider: deletion is terminal at Stripe, so a
      // `deleted` event can never be stale, and a replay is idempotent. It
      // still takes the per-subscription lock (review M-1), so it serialises
      // with an in-flight subscription_upserted for the same id.
      // Mark the row canceled and downgrade the entitlement. Stripe sends
      // customer.subscription.deleted when the paid period has ended (or on an
      // immediate cancel), so access ends now. readSnapshot also gates on
      // subscription status, so a stale 'pro' row can never outlive this.
      const done = await withSubscriptionLock(providerName, evt.providerSubscriptionId, async (q) => {
        const stored = await readStoredSub(providerName, evt.providerSubscriptionId, q);
        const res = await q.query<{ user_id: string; plan_code: 'pro' | 'studio'; current_period_end: Date }>(
          `UPDATE subscriptions
              SET status = 'canceled', cancel_at_period_end = true, updated_at = now()
            WHERE provider = $1 AND provider_subscription_id = $2
            RETURNING user_id, plan_code, current_period_end`,
          [providerName, evt.providerSubscriptionId],
        );
        const row = res.rows[0];
        const userId =
          row?.user_id ??
          (await resolveUserId(
            providerName,
            { userId: evt.userId, customerId: evt.providerCustomerId },
            q,
          ));
        // Review M-1 demo 2: `deleted` can land before any row exists (its
        // `created` is still in flight, or failed and will be retried). Leave
        // a canceled TOMBSTONE so the terminal guard in subscription_upserted
        // blocks that later write. It needs a known plan (plans FK) and a user
        // row that STILL EXISTS: it never creates one (review R2-1). After an
        // account deletion the auth.users cascade has removed public.users and
        // every subscription row, so there is nothing to protect and no row
        // to point at; recreating the user would violate its FK to auth.users
        // and 500 on every retry. Without a tombstone the lock alone still
        // orders the two deliveries.
        if (!row && userId) {
          const plan = evt.planCode === 'pro' || evt.planCode === 'studio' ? evt.planCode : null;
          if (plan) {
            const end = evt.currentPeriodEnd ?? new Date();
            let start = evt.currentPeriodStart ?? new Date(end.getTime() - 1000);
            if (start.getTime() >= end.getTime()) start = new Date(end.getTime() - 1000);
            const tomb = await q.query(
              `INSERT INTO subscriptions
                 (user_id, provider, provider_subscription_id, plan_code, status,
                  current_period_start, current_period_end, cancel_at_period_end)
               SELECT $1::uuid, $2::text, $3::text, $4::text, 'canceled', $5::timestamptz, $6::timestamptz, true
                WHERE EXISTS (SELECT 1 FROM users WHERE id = $1::uuid)
               ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
                 status = 'canceled', cancel_at_period_end = true, updated_at = now()`,
              [userId, providerName, evt.providerSubscriptionId, plan, start, end],
            );
            if ((tomb.rowCount ?? 0) === 0) {
              console.info(
                `[webhook] subscription_canceled ${evt.providerSubscriptionId}: user ${userId} no longer exists; no tombstone`,
              );
            }
          } else {
            console.warn(
              `[webhook] subscription_canceled ${evt.providerSubscriptionId}: no row and no known plan; no tombstone`,
            );
          }
        }
        if (userId) await downgradeEntitlementIfUnentitled(userId, q);
        return { stored, row, userId };
      });
      const { stored, row, userId } = done;
      if (userId) invalidateEntitlement(userId);
      // R6, plan ended (emails v1.2; fixes E1). Sent only when we know which
      // plan ended (a stored row) and it was a plan the user actually had:
      // not when Stripe says the subscription was never paid (status
      // incomplete / incomplete_expired on the event), and not when our row
      // was still `incomplete` (invoice_payment_failed no longer flips an
      // incomplete row to past_due, so that status survives; review B1).
      // A stored `canceled` is NOT skipped: that is what a Stripe retry after
      // a partial failure of this handler sees, and skipping it would lose
      // the email (review B2). A repeat send is stopped by the
      // sub-changed:<id>:canceled Resend key. The old code guessed 'pro' when
      // the row was missing and told the user they would keep access. A
      // tombstone is not a stored row: no R6 for it.
      if (
        userId &&
        row &&
        stored.known &&
        !evt.neverPaid &&
        stored.row?.status !== 'incomplete'
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
        // Same per-subscription lock as the subscription events (review
        // M-1), so this read-then-write cannot interleave with a cancel.
        const sub = await withSubscriptionLock(providerName, evt.providerSubscriptionId, async (q) => {
          const s = await getBillingProvider().getSubscription(evt.providerSubscriptionId);
          await upsertEntitlementFromSubscription(userId, s, q);
          return s;
        });
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
      // QA B-04, same bug class as subscription_upserted: this used to flip
      // the row to past_due on the event alone, so a stale or late
      // payment_failed that landed AFTER the retry succeeded (invoice.paid)
      // left a paying subscriber past_due, and readSnapshot dropped them to
      // free once the grace window ran out. Now the subscription is re-read
      // (inside the per-subscription lock, review M-1) and its CURRENT
      // status is applied. A failed read throws (500, Stripe retries).
      const reason = evt.billingReason ?? null;
      const outcome = await withSubscriptionLock(providerName, evt.providerSubscriptionId, async (q) => {
        const current = await readCurrentSubscription('invoice_payment_failed', evt.providerSubscriptionId);
        if (!current) return null;
        // Only the statuses this event can settle are written here: past_due
        // (the failure stands; access continues for PAST_DUE_GRACE_MS,
        // applied by readSnapshot, then drops to free) or active/trialing
        // (typically: the retry already succeeded, so the event is stale).
        // canceled / paused / incomplete belong to the
        // subscription events, which re-read too and also move the
        // entitlement. The row guard is unchanged: never touch a never-paid
        // `incomplete` row (review B1) or a terminal `canceled` one.
        const settles = ['past_due', 'active', 'trialing'].includes(current.status);
        if (!settles) {
          console.info(
            `[webhook] invoice_payment_failed ${evt.providerInvoiceId ?? '?'}: subscription ${evt.providerSubscriptionId} is ${current.status}; left to subscription events`,
          );
          return { current, failedRow: undefined, invoiceUnpaid: false };
        }
        const res = await q.query<{
          user_id: string;
          plan_code: 'pro' | 'studio';
          current_period_start: Date | string | null;
        }>(
          `UPDATE subscriptions SET status = $3, updated_at = now()
            WHERE provider = $1 AND provider_subscription_id = $2
              AND status NOT IN ('incomplete', 'canceled')
            RETURNING user_id, plan_code, current_period_start`,
          [providerName, evt.providerSubscriptionId, current.status],
        );
        const failedRow = res.rows[0];
        // Review L-1. With a card, a failed renewal moves the subscription to
        // past_due. When Stripe still says active/trialing, decide R7 from
        // the invoice itself: still `open` with an amount due means the
        // customer must act; `paid` means the event is stale. This does NOT
        // cover a delayed payment method (ACH / PAD) failing later: there
        // Stripe VOIDS the invoice and keeps the subscription active, so no
        // R7 is sent (nothing is owed on a void invoice). See the PR body's
        // residue. Only read when an email could follow.
        let invoiceUnpaid = false;
        const provider = getBillingProvider();
        if (
          current.status !== 'past_due' &&
          reason === 'subscription_cycle' &&
          failedRow &&
          evt.providerInvoiceId &&
          provider.getInvoiceState
        ) {
          const inv = await provider.getInvoiceState(evt.providerInvoiceId);
          invoiceUnpaid = inv.status === 'open' && inv.amountRemaining > 0;
        }
        return { current, failedRow, invoiceUnpaid };
      });
      if (!outcome) return;
      const { current, failedRow, invoiceUnpaid } = outcome;
      const failedUser = failedRow?.user_id ?? evt.userId;
      if (failedUser) invalidateEntitlement(failedUser);
      // R7, payment failed (emails v1.2; fixes E5). Only for a RENEWAL
      // (billing_reason subscription_cycle), and only when a paid
      // subscription matched the UPDATE above. A failed FIRST payment
      // (subscription_create) sends nothing and, since the UPDATE skips
      // `incomplete` rows, never turns a never-paid subscription into
      // past_due (review B1). subscription_update is excluded too: the copy
      // says "renewal", and a proration invoice's line period starts at the
      // change, not at the cycle start the grace window counts from (M-a).
      if (reason !== 'subscription_cycle') {
        console.info(
          `[webhook] invoice_payment_failed ${evt.providerInvoiceId ?? '?'}: no email (billing_reason=${reason ?? 'none'})`,
        );
        return;
      }
      if (!failedRow || !evt.providerInvoiceId) return;
      // A stale failure (the retry already succeeded) sends no R7.
      if (current.status !== 'past_due' && !invoiceUnpaid) {
        console.info(
          `[webhook] invoice_payment_failed ${evt.providerInvoiceId}: no email (subscription is ${current.status}, invoice not open)`,
        );
        return;
      }
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
      // Review L-5: a paid session (or subscription) the provider could not
      // map carries an alert. Stripe still gets 200 (a retry cannot fix a
      // price we do not know), but a human is paged through Sentry.
      if (evt.alert) alertBilling(evt.alert, { eventType: evt.eventType, ...(evt.alertDetail ?? {}) });
      return;
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
    // The signature was fine but a read back from the provider failed (e.g.
    // a credit session's line items): 500 so Stripe retries. A 400 would
    // drop a paid purchase for good.
    if (err instanceof Error && err.name === 'BillingProviderUnavailableError') {
      console.error('[webhook] provider read failed, asking for a retry:', err.message);
      return NextResponse.json({ error: 'provider_unavailable' }, { status: 500 });
    }
    // Review I-1: a live event against a test key (or the reverse). Fail
    // CLOSED and loud: nothing is granted, Stripe keeps retrying (~3 days)
    // so the events can still be processed once the config is fixed.
    if (err instanceof Error && err.name === 'BillingModeMismatchError') {
      alertBilling('Stripe event mode does not match the API key mode', { error: err.message });
      return NextResponse.json({ error: 'mode_mismatch' }, { status: 500 });
    }
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
