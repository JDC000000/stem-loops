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
  /** When the provider created the subscription (Stripe `created`). Used to
   *  tell a redelivered first activation from a re-subscription (B3). */
  createdAt?: Date | null;
}

/** What cancelAllForAccountDeletion did (QA-53). Ids only, no personal data. */
export interface AccountDeletionCancelResult {
  /** Subscriptions this call cancelled. */
  cancelled: string[];
  /** Subscriptions that were already over (cancelled / expired / gone). */
  alreadyOver: string[];
  /** Never-paid first invoices this call voided (incomplete subscriptions). */
  voidedInvoices: string[];
}

/** Fields of a subscription an update event reports as changed. */
export interface BillingSubscriptionChange {
  status?: SubscriptionStatus;
  planCode?: PlanCode;
  cancelAtPeriodEnd?: boolean;
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
      /**
       * What the event itself says changed (Stripe `data.previous_attributes`).
       * null for customer.subscription.created (a new subscription). For an
       * update, a field is present only if Stripe reports it changed.
       * Billing emails derive the transition from this, NOT from our stored
       * row, so a Stripe retry after a partial failure re-derives the same
       * email (emails v1.2 R4/R5; PR #272 review B2).
       */
      previous?: BillingSubscriptionChange | null;
    }
  | {
      type: 'subscription_canceled';
      userId: string;
      providerSubscriptionId: string;
      providerCustomerId?: string | null;
      /** True when Stripe ended a subscription that was never paid
       *  (status incomplete / incomplete_expired). No plan-ended email. */
      neverPaid?: boolean;
      /** From the payload, only to write a canceled TOMBSTONE when no row
       *  exists yet (review M-1 demo 2). null when the price is unknown. */
      planCode?: PlanCode | null;
      currentPeriodStart?: Date | null;
      currentPeriodEnd?: Date | null;
    }
  | {
      type: 'invoice_paid';
      userId: string;
      providerSubscriptionId: string;
      providerCustomerId?: string | null;
      invoice: BillingInvoice;
      /** Stripe invoice.billing_reason: 'subscription_create' labels the first
       *  invoice "Pro plan", 'subscription_cycle' a "Pro plan renewal" (E4). */
      billingReason?: string | null;
    }
  | {
      type: 'invoice_payment_failed';
      userId: string;
      providerSubscriptionId: string;
      providerCustomerId?: string | null;
      /** Fields below feed the R7 payment-failed email (emails v1.2 §3 R7). */
      providerInvoiceId?: string | null;
      /** invoice.attempt_count; part of the R7 idempotency key. */
      attemptCount?: number | null;
      /** invoice.next_payment_attempt, or null when none is scheduled. */
      nextPaymentAttempt?: Date | null;
      /** The subscription line's period.start: the period the failed charge
       *  is for. R7's grace date is this + PAST_DUE_GRACE_MS. */
      periodStart?: Date | null;
      /** invoice.billing_reason. R7 is sent only for subscription_cycle and
       *  subscription_update; a failed first payment (subscription_create)
       *  sends nothing. */
      billingReason?: string | null;
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
      /** QA-72. A Checkout Session in subscription mode completed. Nothing is
       *  granted from it (the customer.subscription.* events do that); the
       *  route only uses it to catch a subscription bought by an account that
       *  no longer exists (an open session completed after the account was
       *  deleted) and close it. */
      type: 'subscription_checkout_completed';
      /** session.metadata.user_id, '' when absent. */
      userId: string;
      providerSubscriptionId: string;
      providerCustomerId: string | null;
    }
  | {
      type: 'unhandled';
      eventType: string;
      /** Set when money may have been taken but nothing was granted (review
       *  L-5). The route answers 200 and raises this to Sentry. */
      alert?: string;
      alertDetail?: Record<string, unknown>;
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

  /** Current state of an invoice: the provider's status ('open', 'paid',
   *  'void', ...) and the amount still due, minor units. Optional: a
   *  provider without it never makes the payment-failed email depend on
   *  the invoice (review L-1). */
  getInvoiceState?(invoiceId: string): Promise<{ status: string; amountRemaining: number }>;

  cancelSubscription(
    subscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<void>;

  /** QA-53. Account deletion: cancel, immediately, EVERY subscription that is
   *  not already over, whatever its status (active, trialing, past_due,
   *  paused, incomplete, unpaid, or a status we do not know yet), and void a
   *  never-paid first invoice so it cannot be paid later. `knownIds` are the
   *  ids our DB holds; `customerId` (when we have one) is also listed at the
   *  provider, so a subscription the webhook has not written yet is caught.
   *  Throws (nothing to undo on our side) if any of it fails or if
   *  `deadlineMs` (epoch ms) would be passed; safe to call again. */
  cancelAllForAccountDeletion(
    knownIds: string[],
    customerId: string | null,
    deadlineMs: number,
  ): Promise<AccountDeletionCancelResult>;

  handleWebhook(rawBody: string, signature: string): Promise<BillingEvent>;

  listInvoices(customerId: string): Promise<BillingInvoice[]>;

  applyPromoCode(sessionId: string, code: string): Promise<void>;

  /** Resolve a human promo code to the provider's promotion-code id. Returns
   *  null (never throws) when unknown/inactive/unsupported. Optional so
   *  providers without the concept (Paddle) need not implement it. */
  resolvePromotionCodeId?(code: string): Promise<string | null>;

  /** The customer's NON-TERMINAL subscriptions as the provider sees them right
   *  now (Stripe: everything but canceled / incomplete_expired), for the
   *  checkout guard's stale-sync fallback (lib/billing/checkout-guard.ts): a
   *  Checkout that completed before its webhook landed. `status` is the
   *  provider's own value. Bounded read; throws on timeout or error. Optional:
   *  a provider without it gets the DB check only. */
  listLiveSubscriptions?(customerId: string): Promise<Array<{ id: string; status: string }>>;

  /** QA-72. Account deletion: expire every OPEN checkout session of the
   *  customer, so none can be completed (and bill) after the account is gone.
   *  Bounded: throws instead of starting a call that could end after
   *  `deadlineMs` (epoch ms), and on any refusal. Safe to call again. */
  expireOpenCheckoutSessions(customerId: string, deadlineMs: number): Promise<{ expired: string[] }>;

  /** QA-72 webhook backstop. A subscription whose account was PROVEN deleted
   *  through the app (the caller checked the account_deleted audit row):
   *  cancel it now and give the money back (see OrphanSubscriptionResult).
   *  Never called without that proof (review M-2). Throws on any retryable
   *  refusal or when `deadlineMs` would be passed; safe to call again (every
   *  step re-reads provider state first). */
  closeOrphanSubscription(
    subscriptionId: string,
    deadlineMs: number,
    opts: OrphanCloseOptions,
  ): Promise<OrphanSubscriptionResult>;
}

/** Inputs of closeOrphanSubscription (QA-72, review M-1 / M-3). */
export interface OrphanCloseOptions {
  /** The cancellation comment this subscription's backstop cancel writes and
   *  is recognised by: an HMAC over the subscription id keyed with a server
   *  secret, computed by the caller. Compared in constant time. A customer
   *  cannot type it (they do not know the key), so a portal comment can never
   *  authorise a refund (review M-1). */
  marker: string;
  /** When the account was deleted (epoch ms, the account_deleted audit row). */
  deletedAtMs: number;
  /** invoice.paid: the invoice that was paid. Refunded in full when it was
   *  paid at or after deletedAtMs, even on a subscription the deletion itself
   *  cancelled (review M-3: a renewal paid after the account was gone). */
  paidInvoiceId?: string | null;
}

/** What closeOrphanSubscription did (QA-72). Provider ids only, no personal data. */
export interface OrphanSubscriptionResult {
  subscriptionId: string;
  customerId: string | null;
  /** The provider has no such subscription (nothing to do). */
  gone: boolean;
  /** This call cancelled it. */
  cancelled: boolean;
  /** It is cancelled and WE cancelled it as an orphan (now or on an earlier
   *  delivery), recognised by the HMAC marker. Only then is its latest
   *  invoice refunded: a subscription the account deletion itself cancelled
   *  was paid for a period the user had. */
  ours: boolean;
  /** Review L-2: one of its items is not on one of our subscription prices
   *  (a Dashboard / Payment Link product). Nothing was written at the
   *  provider; the caller alerts a human. */
  foreignPrice: boolean;
  /** Open invoice voided by this call (it would stay payable). */
  voidedInvoiceId: string | null;
  /** Invoices this call refunded (or found refunded): the latest one of a
   *  subscription that is ours, and/or a paid-after-deletion one (M-3). */
  refundedInvoiceIds: string[];
  /** The paidInvoiceId was paid at or after the deletion (review M-3). */
  paidAfterDeletion: boolean;
  /** Refunds created by this call (one per paid payment of each invoice). */
  refundIds: string[];
  /** Minor units refunded by this call. */
  amountRefunded: number;
  currency: string | null;
  /** An invoice's payment was already refunded (an earlier delivery). */
  alreadyRefunded: boolean;
  /** Set to the invoice id when it is paid, with money on it, but the
   *  provider listed no refundable payment for it, or refused a refund that
   *  can never succeed (review L-4: e.g. a disputed charge): a human must
   *  settle it. */
  refundGapInvoiceId: string | null;
  /** Review L-4: the provider's code for a refund that can never succeed. */
  refundRefusedCode: string | null;
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`BillingProvider method '${method}' not implemented in this provider.`);
    this.name = 'NotImplementedError';
  }
}
