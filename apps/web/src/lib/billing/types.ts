// BillingProvider interface + shared types.
//
// Per TSD-V3-DELTA.md §1.1 (V3-C1 abstraction surface — LOCKED per Jon
// 2026-11-02T22:45): all processor-specific code lives behind this
// interface. Stripe is the primary; Paddle is the warm-standby. A mid-flight
// swap (if Stripe freezes payouts, accepted-risk S4) is "hours, not weeks"
// — only this interface and its two implementations should know whether a
// customer is on Stripe or Paddle.
//
// Code ORGANIZATION contract (audit blocker #3):
//   apps/web/src/lib/billing/types.ts            — THIS FILE (interface)
//   apps/web/src/lib/billing/index.ts            — singleton selector by env
//   apps/web/src/lib/billing/providers/stripe.ts — StripeProvider
//   apps/web/src/lib/billing/providers/paddle.ts — PaddleProvider (stub Phase 1a)
//   apps/worker/src/worker/billing/providers/... — mirror on worker side

// Plan codes map to the subscriptions.plan_code column (TSD §2.3) which
// FKs into plans.code. Locked catalog per Jon 2026-11-02T22:45 and
// 014_v3_seed_plans.sql: 'free' | 'pro' | 'studio'. Earlier drafts of
// this file used 'pro_monthly' / 'studio_monthly'; those never existed in
// the DB and would have caused a plan_code FK violation on every checkout.
// Free is included for completeness but has no checkout — the free tier
// is the anonymous device-fingerprint cohort (§1.2).
export type PlanCode = 'free' | 'pro' | 'studio';

// Pack codes map to credit_purchases.pack_code (TSD §1.9). Credits never
// expire; one-time Stripe Checkout.
export type PackCode = 'credits_20' | 'credits_60' | 'credits_180';

// Subscription status mirrors the CHECK constraint in TSD §2.3 /
// migration 013. Exactly the six values the DB accepts; writing anything
// else to subscriptions.status is a CHECK-violation 500.
//
// Stripe's own Subscription.Status has extra values ('incomplete_expired',
// 'unpaid') that must be remapped before they hit this type or the DB.
// See `_mapStripeStatus` in providers/stripe.ts — it is the ONLY place
// a Stripe status is allowed to become a SubscriptionStatus.
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'paused';

export interface BillingCustomer {
  providerCustomerId: string;
  userId: string;
}

export interface BillingCheckoutResult {
  sessionId: string;
  url: string;
}

export interface BillingPortalResult {
  url: string;
}

export interface BillingSubscription {
  providerSubscriptionId: string;
  providerCustomerId: string;
  priceId: string;
  planCode: PlanCode;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingInvoice {
  providerInvoiceId: string;
  amountCents: number;
  currency: string;
  paidAt: Date | null;
  hostedInvoiceUrl: string | null;
}

// Discriminated union returned by handleWebhook. Callers switch on `type`
// and persist via the DB layer; the provider does NOT touch DB.
export type BillingEvent =
  | {
      type: 'credit_purchase_completed';
      userId: string;
      packCode: PackCode;
      providerChargeId: string;
      amountCents: number;
      currency: string;
      priceId: string;
      promoCode?: string;
      // Stripe promotion_code id (promo_...) resolved at checkout creation and
      // carried in session.metadata. Gives promo_redemptions a non-NULL dedup key.
      promoCodeId?: string;
      // From Stripe Checkout Session: customer_email on the completed
      // session. The webhook uses this as a fallback to seed public.users
      // when the handle_new_user trigger has not caught up (round-1 MEDIUM
      // on ensureUserRow silent return).
      customerEmail?: string | null;
      // Stripe customer id on the completed session. Fallback key to resolve
      // userId (via customers_billing) when session.metadata.user_id is empty.
      providerCustomerId?: string | null;
    }
  | {
      type: 'subscription_upserted';
      userId: string;
      subscription: BillingSubscription;
    }
  | {
      type: 'subscription_canceled';
      userId: string;
      providerSubscriptionId: string;
      providerCustomerId?: string | null;
    }
  | {
      type: 'invoice_paid';
      userId: string;
      providerSubscriptionId: string;
      providerCustomerId?: string | null;
      invoice: BillingInvoice;
    }
  | {
      type: 'invoice_payment_failed';
      userId: string;
      providerSubscriptionId: string;
      providerCustomerId?: string | null;
    }
  | {
      type: 'dispute_created';
      /** Stripe event id — idempotency key for the clawback adjustment. */
      providerEventId: string;
      /** Stripe charge id (ch_...). */
      providerChargeId: string;
      /** Stripe payment_intent id (pi_...); credit_purchases keys on this. */
      providerPaymentIntentId: string | null;
    }
  | {
      type: 'refund_created';
      /** Stripe event id — idempotency key for credit_adjustments. */
      providerEventId: string;
      /** Stripe charge id (ch_...). */
      providerChargeId: string;
      /** Stripe payment_intent id (pi_...). credit_purchases.provider_charge_id
       *  stores the PaymentIntent id, so the webhook matches on either. */
      providerPaymentIntentId: string | null;
      /** true only when the charge is fully refunded (Stripe charge.refunded). */
      fullyRefunded: boolean;
      /** Cumulative refunded so far, minor units (Stripe charge.amount_refunded). */
      amountRefunded: number;
    }
  | {
      type: 'unhandled';
      eventType: string;
    };

// The 9-method contract from TSD §1.1.
export interface BillingProvider {
  readonly name: 'stripe' | 'paddle';

  createCustomer(userId: string, email: string): Promise<BillingCustomer>;

  /** `customerId` is the provider customer stored in customers_billing. It
   *  MUST be passed: without it the provider mints a throwaway customer per
   *  session, the stored one stays empty, and the portal opens an empty
   *  customer (subscriber cannot cancel). */
  createCheckoutSession(
    userId: string,
    planCode: PlanCode,
    successUrl: string,
    cancelUrl: string,
    promoCode?: string | null,
    promoCodeId?: string | null,
    customerId?: string | null,
  ): Promise<BillingCheckoutResult>;

  /** See createCheckoutSession re `customerId`. */
  createCreditPurchaseSession(
    userId: string,
    pack: PackCode,
    successUrl: string,
    cancelUrl: string,
    promoCode?: string | null,
    promoCodeId?: string | null,
    customerId?: string | null,
  ): Promise<BillingCheckoutResult>;

  createPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<BillingPortalResult>;

  getSubscription(subscriptionId: string): Promise<BillingSubscription>;

  cancelSubscription(
    subscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<void>;

  handleWebhook(rawBody: string, signature: string): Promise<BillingEvent>;

  listInvoices(customerId: string): Promise<BillingInvoice[]>;

  applyPromoCode(sessionId: string, code: string): Promise<void>;

  /** Resolve a human promo code to the provider's promotion-code id. Returns
   *  null (never throws) when unknown/inactive/unsupported. Optional so
   *  providers without the concept (Paddle) need not implement it. */
  resolvePromotionCodeId?(code: string): Promise<string | null>;
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`BillingProvider method '${method}' not implemented in this provider.`);
    this.name = 'NotImplementedError';
  }
}
