// StripeProvider — implements BillingProvider for Stripe.
//
// Replaces the old apps/web/src/lib/stripe.ts (PR #11), which shipped at the
// wrong location and without the interface wrapper. Per TSD §1.1 all
// processor-specific code lives under lib/billing/providers/. Audit blocker
// #3 fix.
//
// API version pinned to '2026-10-28.endive' per TSD lock (session 2
// provisioning walkthrough).

import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import {
  type AccountDeletionCancelResult,
  type BillingCheckoutResult,
  type BillingCustomer,
  type BillingEvent,
  type BillingInvoice,
  type BillingPortalResult,
  type BillingProvider,
  type BillingSubscription,
  type BillingSubscriptionChange,
  type PackCode,
  type PlanCode,
  type SubscriptionStatus,
} from '../types';

export const STRIPE_API_VERSION = '2026-10-28.endive' as const;

// 8-letter random suffix per Stripe best-practices (API ≥ 2026-03-25.dahlia).
const INTEGRATION_ID = 'stem_loops_v3_hxkpqrst';

// Env-driven SKU → price_id lookup. Defaults are BC sandbox (session 2).
// Prod sets the env vars to live-mode IDs after account completion.
const PACK_PRICE_ENV: Record<PackCode, { env: string; fallback: string }> = {
  credits_20: { env: 'STRIPE_PRICE_CREDITS_20', fallback: 'price_1UXmVkLrVEo8Syzr4hhA6nW8' },
  credits_60: { env: 'STRIPE_PRICE_CREDITS_60', fallback: 'price_1UXmVlLrVEo8SyzrG2giylaj' },
  credits_180: { env: 'STRIPE_PRICE_CREDITS_180', fallback: 'price_1UXmVmLrVEo8SyzrZoUF64Ji' },
};
const PLAN_PRICE_ENV: Record<Exclude<PlanCode, 'free'>, { env: string; fallback: string }> = {
  pro: { env: 'STRIPE_PRICE_PRO_MONTHLY', fallback: 'price_1UXmVmLrVEo8SyzrzdLgw02p' },
  studio: { env: 'STRIPE_PRICE_STUDIO_MONTHLY', fallback: 'price_1UXmVnLrVEo8SyzrOb1nASza' },
};

function packPriceId(pack: PackCode): string {
  const cfg = PACK_PRICE_ENV[pack];
  return process.env[cfg.env] ?? cfg.fallback;
}

function planPriceId(plan: Exclude<PlanCode, 'free'>): string {
  const cfg = PLAN_PRICE_ENV[plan];
  return process.env[cfg.env] ?? cfg.fallback;
}

// Reverse lookup: Stripe price_id → our PackCode / PlanCode (webhook uses this
// to derive the authoritative SKU from the subscription's actual price_id,
// not from stale metadata — fixes PR #13 review finding A2/C4).
function priceIdToPack(priceId: string): PackCode | null {
  for (const pack of Object.keys(PACK_PRICE_ENV) as PackCode[]) {
    if (packPriceId(pack) === priceId) return pack;
  }
  return null;
}
function priceIdToPlan(priceId: string): Exclude<PlanCode, 'free'> | null {
  for (const plan of Object.keys(PLAN_PRICE_ENV) as Exclude<PlanCode, 'free'>[]) {
    if (planPriceId(plan) === priceId) return plan;
  }
  return null;
}

// Lazy singleton; throws at call time if STRIPE_SECRET_KEY unset.
let _client: Stripe | null = null;
let _warnedAboutSecretKey = false;
function getClient(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add a restricted API key (rk_ prefix) to Vercel env.',
    );
  }
  if (!key.startsWith('rk_') && !key.startsWith('sk_')) {
    throw new Error(
      `STRIPE_SECRET_KEY has an unexpected prefix: expected "rk_" or "sk_", got "${key.slice(0, 3)}…"`,
    );
  }
  if (key.startsWith('sk_') && !_warnedAboutSecretKey) {
    console.warn(
      '[stripe] key uses sk_ prefix — prefer a restricted key (rk_) in production.',
    );
    _warnedAboutSecretKey = true;
  }
  _client = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    telemetry: false,
    appInfo: { name: 'stem-loops', version: '3.0.0-dev', url: 'https://stem-loops.com' },
  });
  return _client;
}



function warnIfNoCustomer(method: string, customerId?: string | null): void {
  if (!customerId) {
    console.warn(
      `[stripe] ${method} called without customerId — Stripe will mint a throwaway customer and the billing portal will be empty`,
    );
  }
}

function _customerId(c: string | { id: string } | null | undefined): string | null {
  if (!c) return null;
  return typeof c === 'string' ? c : c.id;
}

// Pull the subscription id out of an Invoice across API-version shapes.
// 2026-03-25.dahlia+ moved it under invoice.parent.subscription_details.
function _invoiceSubId(invoice: Stripe.Invoice): string | undefined {
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy === 'object') return legacy.id;
  const parent = (invoice as unknown as { parent?: { type?: string; subscription_details?: { subscription?: string } } }).parent;
  if (parent?.type === 'subscription_details') return parent.subscription_details?.subscription;
  return undefined;
}

// The subscription fields a customer.subscription.updated event reports as
// changed (event.data.previous_attributes). Only fields Stripe lists are set;
// an unknown status or price is dropped rather than guessed.
function _previousAttributes(data: { previous_attributes?: unknown }): BillingSubscriptionChange {
  const prev = (data.previous_attributes ?? {}) as {
    status?: unknown;
    cancel_at_period_end?: unknown;
    items?: { data?: Array<{ price?: { id?: unknown } }> };
  };
  const out: BillingSubscriptionChange = {};
  if (typeof prev.status === 'string') {
    try {
      out.status = _mapStripeStatus(prev.status as Stripe.Subscription.Status);
    } catch {
      // Unknown previous status: leave it out.
    }
  }
  if (typeof prev.cancel_at_period_end === 'boolean') out.cancelAtPeriodEnd = prev.cancel_at_period_end;
  const priceId = prev.items?.data?.[0]?.price?.id;
  if (typeof priceId === 'string') {
    const plan = priceIdToPlan(priceId);
    if (plan) out.planCode = plan;
  }
  return out;
}

// Start of the period a subscription invoice charges for: the subscription
// line's period.start (InvoiceLineItem.parent.type 'subscription_item_details'
// in 2026-03-25.dahlia+), falling back to the first line. Used by R7, so a
// failed renewal that arrives before customer.subscription.updated still gets
// the right grace date. Null when the payload carries no lines.
function _invoiceSubscriptionPeriodStart(invoice: Stripe.Invoice): Date | null {
  const lines = invoice.lines?.data ?? [];
  const subLine =
    lines.find((l) => l.parent?.type === 'subscription_item_details') ?? lines[0];
  const start = subLine?.period?.start;
  return typeof start === 'number' && start > 0 ? new Date(start * 1000) : null;
}

// user_id for an invoice: invoice.metadata is empty on subscription invoices;
// newer API versions carry the subscription's metadata under
// invoice.parent.subscription_details.metadata. Empty string when neither has
// it — the webhook route then resolves via customers_billing / subscriptions.
function _invoiceUserId(invoice: Stripe.Invoice): string {
  const parent = (invoice as unknown as {
    parent?: { subscription_details?: { metadata?: Record<string, string> | null } };
  }).parent;
  return (
    (invoice.metadata?.user_id as string | undefined) ||
    parent?.subscription_details?.metadata?.user_id ||
    ''
  );
}

// Thrown by handleWebhook when the event's signature was valid but a read
// back from Stripe (a Checkout Session's line items) failed. The webhook
// route answers 500 for it so Stripe RETRIES; every other handleWebhook
// failure is treated as a bad signature and answered 400 (no retry). The
// route matches it by `name`, not instanceof (it only sees the provider
// through the BillingProvider interface).
export class BillingProviderUnavailableError extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'BillingProviderUnavailableError';
  }
}

// PR #298 review R2-2 / R3-2. Every Stripe read on the webhook path (most of
// them inside a DB transaction holding a per-subscription lock) is bounded:
// 6 s per attempt, no configured retries. stripe-node's defaults are an 80 s
// timeout and 2 network retries, i.e. minutes holding a pooled connection
// and an open transaction. NOTE: even with maxNetworkRetries 0, stripe-node
// 23 retries ONCE on ECONNRESET / EPIPE (RequestSender._shouldRetry), so one
// read can take up to 2 x 6 s = 12 s; the route's time budget counts that.
// A timeout surfaces as an error; the webhook answers 500 and STRIPE retries
// the delivery (it retries for days), which is the right retry layer.
export const STRIPE_WEBHOOK_READ_OPTIONS = Object.freeze({ timeout: 6000, maxNetworkRetries: 0 });

// Checkout guard (decision 1A): the one Stripe READ on the checkout request path,
// bounded the same way (#298): 5 s per attempt, no configured retries, so at
// most 2 x 5 s = 10 s with stripe-node's forced reset retry. A timeout throws;
// the checkout route answers 502 CHECKOUT_FAILED (never "clear").
export const STRIPE_CHECKOUT_READ_OPTIONS = Object.freeze({ timeout: 5000, maxNetworkRetries: 0 });

// Stripe statuses that can never bill again. Anything else, including a status
// this SDK does not name yet, counts as live for the checkout guard (fail safe:
// a refused checkout is recoverable, a second subscription is a double charge),
// and is cancelled by account deletion (QA-53: active, trialing, past_due,
// paused, incomplete, unpaid, or a status a future API version adds).
const TERMINAL_STRIPE_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

// Worst case of ONE bounded Stripe call: STRIPE_WEBHOOK_READ_OPTIONS.timeout
// per attempt, and stripe-node retries a reset socket once even with
// maxNetworkRetries 0 (review R3-2), so two attempts.
export const STRIPE_CALL_WORST_MS = 2 * STRIPE_WEBHOOK_READ_OPTIONS.timeout;

/** cancelAllForAccountDeletion would pass its deadline. Nothing past the
 *  last finished call was sent; the caller answers "retry". */
export class StripeDeadlineError extends Error {
  constructor(step: string) {
    super(`Stripe time budget spent before ${step}`);
    this.name = 'StripeDeadlineError';
  }
}

/** Stripe says the object does not exist (deleted customer / subscription). */
function _isStripeGone(e: unknown): boolean {
  const x = e as { code?: string; statusCode?: number } | null;
  return !!x && (x.code === 'resource_missing' || x.statusCode === 404);
}

/** Stripe refused a cancel because the subscription is already cancelled. */
function _isAlreadyCanceled(e: unknown): boolean {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && /already (been )?cancel/i.test(m);
}

interface _SubForDeletion {
  id: string;
  status: string;
  /** The subscription's FIRST invoice when it is still open, i.e. never paid
   *  (an incomplete subscription, or one cancelled while incomplete). Needs
   *  latest_invoice expanded; a bare id is never voided. */
  openFirstInvoiceId: string | null;
}

function _subForDeletion(sub: Stripe.Subscription): _SubForDeletion {
  const inv = sub.latest_invoice;
  const open =
    inv && typeof inv === 'object' && inv.status === 'open' && inv.billing_reason === 'subscription_create'
      ? inv.id ?? null
      : null;
  return { id: sub.id, status: String(sub.status), openFirstInvoiceId: open };
}

// Review I-1: the event's `livemode` disagrees with the API key's mode (a
// live endpoint secret with a test key, or the reverse). Thrown after the
// signature check; the route answers 500 and alerts. Matched by name.
export class BillingModeMismatchError extends Error {
  constructor(eventLive: boolean, keyLive: boolean) {
    super(`event livemode=${eventLive} but STRIPE_SECRET_KEY is a ${keyLive ? 'live' : 'test'} key`);
    this.name = 'BillingModeMismatchError';
  }
}

/** true/false for a live/test key, null when the key does not say. */
function keyIsLive(key: string | undefined): boolean | null {
  if (!key) return null;
  if (/^(sk|rk)_live_/.test(key)) return true;
  if (/^(sk|rk)_test_/.test(key)) return false;
  return null;
}

// Sentinel thrown when a Stripe subscription carries a price_id that doesn't
// map to any known PLAN_PRICE_ENV entry. Previously `priceIdToPlan ?? 'pro'`
// (and before that, `?? 'pro_monthly'`) silently downgraded a studio
// subscriber on an env mismatch, or landed a legacy one-off price on pro —
// HIGH severity MONEY-CODE bug. Now the webhook branch catches this, returns
// an `unhandled` event, and surfaces to Stripe so the operator can see the
// mismatch before it affects anyone's access.
export class UnknownPriceError extends Error {
  readonly priceId: string;
  constructor(priceId: string) {
    super(`Stripe price_id '${priceId}' does not map to any known plan — env mismatch or legacy price`);
    this.name = 'UnknownPriceError';
    this.priceId = priceId;
  }
}

// Sentinel thrown when Stripe emits a Subscription.Status value we do not
// recognize. Modeled after UnknownPriceError: fail loud at the webhook
// boundary rather than silently cast an unknown enum into our narrower
// SubscriptionStatus and CHECK-violation on the DB upsert.
//
// Launch-blocker bug: Stripe's Subscription.Status includes
// 'incomplete_expired' and 'unpaid', which the DB CHECK constraint on
// subscriptions.status (migration 013:117 — 6 values) rejects. Blind
// casting `sub.status as SubscriptionStatus` 500'd the webhook on every
// failed-payment / 3DS-incomplete / past-due-too-long transition and
// silently dropped the sub-state update. See _mapStripeStatus below.
export class UnknownStatusError extends Error {
  readonly stripeStatus: string;
  constructor(stripeStatus: string) {
    super(`Stripe Subscription.Status '${stripeStatus}' is not recognized — Stripe API drift or new enum value`);
    this.name = 'UnknownStatusError';
    this.stripeStatus = stripeStatus;
  }
}

// Map Stripe's Subscription.Status to the 6-value DB-safe SubscriptionStatus.
//
// Stripe enum (as of 2026-10-28.endive): 'trialing' | 'active' | 'past_due'
//   | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused'.
// DB CHECK (migration 013:117): 'trialing' | 'active' | 'past_due' |
//   'canceled' | 'incomplete' | 'paused'.
//
// Remaps:
//   - 'incomplete_expired' → 'canceled'  (Stripe gives up after ~23h of
//     unpaid initial invoice; subscription is dead — treat as canceled.)
//   - 'unpaid'             → 'past_due'  (we don't track the extra
//     "dunning exhausted but not canceled" state; collapse to past_due so
//     the dunning email + access gate still fire.)
// Unknown value → throw UnknownStatusError (fail loud, mirror
// UnknownPriceError; webhook dispatch catches and returns `unhandled`).
export function _mapStripeStatus(
  stripeStatus: Stripe.Subscription.Status,
): SubscriptionStatus {
  // Note on the literal returns: Stripe's Subscription.Status type is
  // `<literals> | OtherString` by design (SDK's shared.ts explains
  // this is to surface future API-version drift without an SDK bump),
  // so `stripeStatus` never narrows to a pure literal inside a case.
  // We return the literal directly instead of `stripeStatus` to avoid
  // an `as SubscriptionStatus` cast that would mask that drift.
  switch (stripeStatus) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    case 'paused':
      return 'paused';
    case 'incomplete_expired':
      return 'canceled';
    case 'unpaid':
      return 'past_due';
    default:
      // Exhaustiveness guard: Stripe's `OtherString` branch widens the
      // enum to `string`, so this is the only hook we have for a value
      // the SDK has not yet named. Fail loud; the webhook dispatch
      // catches and returns `unhandled` so the operator sees the drift.
      throw new UnknownStatusError(stripeStatus as string);
  }
}

function subFromStripe(sub: Stripe.Subscription): BillingSubscription {
  // API 2026-03-25.dahlia+ moved current_period_start/end to SubscriptionItem.
  const firstItem = sub.items.data[0];
  const priceId = firstItem?.price.id ?? '';
  const planCode = priceIdToPlan(priceId);
  if (!planCode) {
    // Never guess — see UnknownPriceError above. #29 (plan-code fix) had
    // this fallback at `?? 'pro'`; #31 (this PR) replaced it with a throw
    // to avoid silently downgrading a studio customer to pro on a
    // price_id mismatch. Throw wins on conflict.
    throw new UnknownPriceError(priceId);
  }
  return {
    providerSubscriptionId: sub.id,
    providerCustomerId:
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    priceId,
    planCode,
    // Remap through _mapStripeStatus — Stripe's enum is wider than our
    // DB CHECK; a blind cast CHECK-violated the webhook on 'unpaid' /
    // 'incomplete_expired'. See _mapStripeStatus / UnknownStatusError.
    status: _mapStripeStatus(sub.status),
    currentPeriodStart: firstItem?.current_period_start
      ? new Date(firstItem.current_period_start * 1000)
      : null,
    currentPeriodEnd: firstItem?.current_period_end
      ? new Date(firstItem.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    createdAt: typeof sub.created === 'number' ? new Date(sub.created * 1000) : null,
  };
}

export class StripeProvider implements BillingProvider {
  readonly name = 'stripe' as const;

  async createCustomer(userId: string, email: string): Promise<BillingCustomer> {
    // Stripe idempotency key: a duplicate createCustomer call for the same
    // user_id returns the same customer instead of minting a second one.
    // Closes PR #12 review finding F-4.
    const customer = await getClient().customers.create(
      { email, metadata: { user_id: userId } },
      { idempotencyKey: `customer:${userId}` },
    );
    return { providerCustomerId: customer.id, userId };
  }

  async createCheckoutSession(
    userId: string,
    planCode: PlanCode,
    successUrl: string,
    cancelUrl: string,
    promoCode?: string | null,
    promoCodeId?: string | null,
    customerId?: string | null,
  ): Promise<BillingCheckoutResult> {
    if (planCode === 'free') {
      throw new Error('createCheckoutSession: "free" plan has no checkout');
    }
    const metadata: Record<string, string> = {
      user_id: userId,
      plan_code: planCode,
      price_id: planPriceId(planCode),
    };
    // MEDIUM fix: thread promo_code into session metadata so the webhook can
    // record it in credit_purchases/promo_redemptions. Previously the route
    // handler accepted promo_code but never passed it to the provider, and
    // the webhook read session.metadata?.promo_code as always undefined.
    if (promoCode) metadata.promo_code = promoCode;
    // M7: resolved at checkout time so the webhook's promo_redemptions insert
    // has a non-NULL UNIQUE key and Stripe retries de-dup.
    if (promoCodeId) metadata.stripe_promotion_code_id = promoCodeId;
    warnIfNoCustomer('createCheckoutSession', customerId);
    const session = await getClient().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: planPriceId(planCode), quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Attach the STORED customer. Without it Stripe mints a throwaway
      // customer per session and the portal opens an empty one.
      ...(customerId ? { customer: customerId } : {}),
      metadata,
      // Stripe does NOT copy session metadata onto the subscription or its
      // invoices. subscription_data.metadata is what lands on the
      // Subscription object, which every customer.subscription.* webhook
      // reads user_id from.
      subscription_data: { metadata: { user_id: userId, plan_code: planCode } },
      integration_identifier: INTEGRATION_ID,
      allow_promotion_codes: true,
      // 3DS forcing per TSD §1.1: subscription cards get Radar 'any' rule;
      // nothing to set here — Radar rule is Dashboard-managed per the spec.
    });
    if (!session.url) {
      throw new Error('Stripe returned no session.url');
    }
    return { sessionId: session.id, url: session.url };
  }

  async createCreditPurchaseSession(
    userId: string,
    pack: PackCode,
    successUrl: string,
    cancelUrl: string,
    promoCode?: string | null,
    promoCodeId?: string | null,
    customerId?: string | null,
  ): Promise<BillingCheckoutResult> {
    const priceId = packPriceId(pack);
    const metadata: Record<string, string> = {
      user_id: userId,
      pack_code: pack,
      price_id: priceId,
    };
    // MEDIUM fix: see createCheckoutSession — thread promo_code through so
    // the one-time credit purchase webhook can audit the coupon redemption.
    if (promoCode) metadata.promo_code = promoCode;
    // M7: resolved at checkout time so the webhook's promo_redemptions insert
    // has a non-NULL UNIQUE key and Stripe retries de-dup.
    if (promoCodeId) metadata.stripe_promotion_code_id = promoCodeId;
    warnIfNoCustomer('createCreditPurchaseSession', customerId);
    const session = await getClient().checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      ...(customerId ? { customer: customerId } : {}),
      metadata,
      integration_identifier: INTEGRATION_ID,
      allow_promotion_codes: true,
      // Per TSD §1.1 "3DS forced on all one-time credit purchases".
      payment_intent_data: { setup_future_usage: undefined },
    });
    if (!session.url) {
      throw new Error('Stripe returned no session.url');
    }
    return { sessionId: session.id, url: session.url };
  }

  async createPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<BillingPortalResult> {
    const session = await getClient().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  async getSubscription(subscriptionId: string): Promise<BillingSubscription> {
    const sub = await getClient().subscriptions.retrieve(subscriptionId, {}, { ...STRIPE_WEBHOOK_READ_OPTIONS });
    return subFromStripe(sub);
  }

  async listLiveSubscriptions(customerId: string): Promise<Array<{ id: string; status: string }>> {
    // No `status` param: Stripe then lists every subscription that is not
    // canceled, newest first. 10 is far above any real customer's count of
    // non-canceled subscriptions; the newest (the one a just-completed
    // Checkout made) is always on the first page.
    const page = await getClient().subscriptions.list(
      { customer: customerId, limit: 10 },
      { ...STRIPE_CHECKOUT_READ_OPTIONS },
    );
    return page.data
      .filter((s) => !TERMINAL_STRIPE_STATUSES.has(s.status))
      .map((s) => ({ id: s.id, status: s.status }));
  }

  async getInvoiceState(invoiceId: string): Promise<{ status: string; amountRemaining: number }> {
    const inv = await getClient().invoices.retrieve(invoiceId, {}, { ...STRIPE_WEBHOOK_READ_OPTIONS });
    return { status: inv.status ?? 'unknown', amountRemaining: inv.amount_remaining ?? 0 };
  }

  async cancelSubscription(
    subscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<void> {
    if (atPeriodEnd) {
      await getClient().subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
    } else {
      await getClient().subscriptions.cancel(subscriptionId);
    }
  }

  // QA-53. Before this, account deletion cancelled only the subscriptions our
  // DB had as active / trialing / past_due, so a paused or incomplete one
  // survived the deletion and could still bill. Now:
  //   1. list the customer's subscriptions AT STRIPE (status 'all'), so one
  //      the webhook has not written yet, or a DB row with a stale status, is
  //      still seen; then retrieve any DB id the list did not return;
  //   2. cancel, immediately, every subscription whose status is not over
  //      (canceled / incomplete_expired). invoice_now and prorate are false
  //      (Stripe's defaults, written out): no final invoice, no proration
  //      credit or charge, pending prorations dropped;
  //   3. void the FIRST invoice when it is still open. Cancelling only turns
  //      off automatic collection on open invoices (auto_advance=false, per
  //      Stripe's cancel docs); an incomplete subscription's first invoice
  //      would stay open and payable through its hosted page / PaymentIntent.
  //      Voiding it closes that, and cancels its PaymentIntent. Later
  //      invoices (a past_due renewal) are a real debt for a period that was
  //      served: they are left as they are, with collection stopped by the
  //      cancel.
  // Every call is bounded like the webhook's (PR #298): 6 s per attempt, no
  // SDK retries, so one call is at most STRIPE_CALL_WORST_MS; before each
  // call we check it can finish by `deadlineMs`, else StripeDeadlineError.
  // The void (a POST) carries an idempotency key, so the SDK's forced retry
  // on a reset socket cannot apply it twice. The cancel is a DELETE, where
  // Stripe ignores idempotency keys (the key sent there has no effect); a
  // repeated cancel fails, and the caller's retry re-reads the state. Safe to call again after any
  // failure: a cancelled subscription reads as over, and its still-open
  // first invoice is voided on the next call.
  async cancelAllForAccountDeletion(
    knownIds: string[],
    customerId: string | null,
    deadlineMs: number,
  ): Promise<AccountDeletionCancelResult> {
    const client = getClient();
    const opts = () => ({ ...STRIPE_WEBHOOK_READ_OPTIONS });
    const postOpts = (what: string, id: string) => ({
      ...STRIPE_WEBHOOK_READ_OPTIONS,
      idempotencyKey: `account-delete-${what}-${id}-${randomUUID()}`,
    });
    const budget = (step: string) => {
      if (Date.now() + STRIPE_CALL_WORST_MS > deadlineMs) throw new StripeDeadlineError(step);
    };
    const result: AccountDeletionCancelResult = { cancelled: [], alreadyOver: [], voidedInvoices: [] };
    const subs = new Map<string, _SubForDeletion>();

    if (customerId) {
      let startingAfter: string | undefined;
      for (;;) {
        budget('subscriptions.list');
        let page: Stripe.ApiList<Stripe.Subscription>;
        try {
          page = await client.subscriptions.list(
            {
              customer: customerId,
              status: 'all',
              limit: 100,
              expand: ['data.latest_invoice'],
              ...(startingAfter ? { starting_after: startingAfter } : {}),
            },
            opts(),
          );
        } catch (e) {
          // A customer Stripe no longer has has no subscriptions left to bill.
          if (_isStripeGone(e)) break;
          throw e;
        }
        for (const sub of page.data) subs.set(sub.id, _subForDeletion(sub));
        if (!page.has_more || page.data.length === 0) break;
        startingAfter = page.data[page.data.length - 1].id;
      }
    }

    for (const id of Array.from(new Set(knownIds))) {
      if (subs.has(id)) continue;
      budget('subscriptions.retrieve');
      try {
        subs.set(id, _subForDeletion(await client.subscriptions.retrieve(id, { expand: ['latest_invoice'] }, opts())));
      } catch (e) {
        if (_isStripeGone(e)) {
          result.alreadyOver.push(id);
          continue;
        }
        throw e;
      }
    }

    for (const found of Array.from(subs.values())) {
      let sub = found;
      if (TERMINAL_STRIPE_STATUSES.has(sub.status)) {
        result.alreadyOver.push(sub.id);
      } else {
        budget('subscriptions.cancel');
        try {
          sub = _subForDeletion(
            await client.subscriptions.cancel(
              sub.id,
              { invoice_now: false, prorate: false, expand: ['latest_invoice'] },
              postOpts('cancel', sub.id),
            ),
          );
          result.cancelled.push(sub.id);
        } catch (e) {
          if (!_isStripeGone(e) && !_isAlreadyCanceled(e)) throw e;
          // Cancelled meanwhile (a webhook-driven expiry, another tab). The
          // invoice state read above is used; if it is stale the void below
          // fails and the caller retries with a fresh read.
          result.alreadyOver.push(sub.id);
        }
      }
      if (sub.openFirstInvoiceId) {
        budget('invoices.voidInvoice');
        await client.invoices.voidInvoice(sub.openFirstInvoiceId, {}, postOpts('void', sub.openFirstInvoiceId));
        result.voidedInvoices.push(sub.openFirstInvoiceId);
      }
    }
    return result;
  }

  async handleWebhook(rawBody: string, signature: string): Promise<BillingEvent> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    }
    const event = getClient().webhooks.constructEvent(rawBody, signature, secret);
    const keyLive = keyIsLive(process.env.STRIPE_SECRET_KEY);
    if (keyLive !== null && typeof event.livemode === 'boolean' && event.livemode !== keyLive) {
      throw new BillingModeMismatchError(event.livemode, keyLive);
    }
    return await this._dispatch(event);
  }

  private async _dispatch(event: Stripe.Event): Promise<BillingEvent> {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'payment' && session.payment_status === 'paid') {
          return await this._creditPurchaseFromSession(session);
        }
        return { type: 'unhandled', eventType: event.type };
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        // API 2026-03-25.dahlia+ moved Invoice.subscription under
        // Invoice.parent.subscription_details.subscription. Accept either shape.
        const sub = _invoiceSubId(invoice);
        if (!sub) return { type: 'unhandled', eventType: event.type };
        return {
          type: 'invoice_paid',
          userId: _invoiceUserId(invoice),
          providerCustomerId: _customerId(invoice.customer),
          providerSubscriptionId: sub,
          invoice: {
            providerInvoiceId: invoice.id,
            amountCents: invoice.amount_paid,
            currency: invoice.currency,
            paidAt: invoice.status_transitions.paid_at
              ? new Date(invoice.status_transitions.paid_at * 1000)
              : null,
            hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          },
          billingReason: invoice.billing_reason ?? null,
        };
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const sub = _invoiceSubId(invoice);
        if (!sub) return { type: 'unhandled', eventType: event.type };
        return {
          type: 'invoice_payment_failed',
          userId: _invoiceUserId(invoice),
          providerCustomerId: _customerId(invoice.customer),
          providerSubscriptionId: sub,
          providerInvoiceId: invoice.id ?? null,
          attemptCount: typeof invoice.attempt_count === 'number' ? invoice.attempt_count : null,
          nextPaymentAttempt: invoice.next_payment_attempt
            ? new Date(invoice.next_payment_attempt * 1000)
            : null,
          periodStart: _invoiceSubscriptionPeriodStart(invoice),
          billingReason: invoice.billing_reason ?? null,
        };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = (sub.metadata?.user_id as string | undefined) ?? '';
        if (event.type === 'customer.subscription.deleted') {
          const item = sub.items?.data?.[0];
          return {
            type: 'subscription_canceled',
            userId,
            providerSubscriptionId: sub.id,
            providerCustomerId: _customerId(sub.customer),
            neverPaid: sub.status === 'incomplete' || sub.status === 'incomplete_expired',
            planCode: item?.price?.id ? priceIdToPlan(item.price.id) : null,
            currentPeriodStart: item?.current_period_start ? new Date(item.current_period_start * 1000) : null,
            currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
          };
        }
        const previous =
          event.type === 'customer.subscription.created'
            ? null
            : _previousAttributes(event.data as { previous_attributes?: unknown });
        try {
          return { type: 'subscription_upserted', userId, subscription: subFromStripe(sub), previous };
        } catch (err) {
          if (!(err instanceof UnknownPriceError) && !(err instanceof UnknownStatusError)) throw err;
          // Review L-4: the PAYLOAD may be stale. An unknown price or status
          // in it says nothing about now, so re-read before dropping: if the
          // CURRENT state maps, it is applied (the route re-reads again under
          // its lock). A failed read is a 500 so Stripe retries.
          let fresh: Stripe.Subscription;
          try {
            fresh = await getClient().subscriptions.retrieve(sub.id, {}, { ...STRIPE_WEBHOOK_READ_OPTIONS });
          } catch (readErr) {
            throw new BillingProviderUnavailableError(`subscriptions.retrieve(${sub.id})`, readErr);
          }
          try {
            return { type: 'subscription_upserted', userId, subscription: subFromStripe(fresh), previous };
          } catch (freshErr) {
            // HIGH #2: an unknown price must NOT silently downgrade to pro,
            // and an unknown status must not CHECK-violate the DB. Drop it
            // (200; a retry cannot fix it) and alert a human.
            if (freshErr instanceof UnknownPriceError || freshErr instanceof UnknownStatusError) {
              const kind = freshErr instanceof UnknownPriceError ? 'unknown_price' : 'unknown_status';
              return {
                type: 'unhandled',
                eventType: `${event.type}:${kind}`,
                alert: `Stripe subscription ${sub.id} not applied: ${freshErr.message}`,
                alertDetail: { subscription: sub.id },
              };
            }
            throw freshErr;
          }
        }
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        const dpi = dispute.payment_intent;
        return {
          type: 'dispute_created',
          providerEventId: event.id,
          providerChargeId:
            typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id,
          providerPaymentIntentId: typeof dpi === 'string' ? dpi : (dpi?.id ?? null),
        };
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const pi = charge.payment_intent;
        return {
          type: 'refund_created',
          providerEventId: event.id,
          providerChargeId: charge.id,
          providerPaymentIntentId: typeof pi === 'string' ? pi : (pi?.id ?? null),
          fullyRefunded: charge.refunded === true,
          amountRefunded: charge.amount_refunded ?? 0,
        };
      }
      default:
        return { type: 'unhandled', eventType: event.type };
    }
  }

  // QA B-15 / B-04 follow-up: the pack is derived from what was actually
  // SOLD — the session's line items — never from session.metadata.
  // session.line_items is NOT populated on webhook events, so the session is
  // always re-read with expand (PR #13 review C1). metadata.price_id /
  // metadata.pack_code are only compared, and a disagreement is logged: a
  // Dashboard / Payment Link session with hand-typed metadata must not be
  // able to turn a credits_20 payment into 180 credits. A failed read is a
  // BillingProviderUnavailableError, which the route answers with 500 so
  // Stripe retries (a 400 would drop a paid purchase for good).
  private async _creditPurchaseFromSession(
    session: Stripe.Checkout.Session,
  ): Promise<BillingEvent> {
    const userId = (session.metadata?.user_id as string | undefined) ?? '';

    let full: Stripe.Checkout.Session;
    try {
      full = await getClient().checkout.sessions.retrieve(
        session.id,
        { expand: ['line_items'] },
        { ...STRIPE_WEBHOOK_READ_OPTIONS },
      );
    } catch (err) {
      throw new BillingProviderUnavailableError(
        `checkout.sessions.retrieve(${session.id})`,
        err,
      );
    }
    const items = full.line_items?.data ?? [];
    const item = items[0];
    const detail = {
      session: session.id,
      payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
      amount_total: full.amount_total ?? session.amount_total ?? null,
      currency: full.currency ?? session.currency ?? null,
    };
    if (items.length !== 1 || (item?.quantity ?? 1) !== 1) {
      return {
        type: 'unhandled',
        eventType: 'checkout.session.completed:unexpected_line_items',
        alert: `Paid credit session ${session.id} NOT granted: expected one line item of quantity 1, got ${items.length} (qty ${item?.quantity ?? 'n/a'})`,
        alertDetail: detail,
      };
    }
    const priceId = item?.price?.id ?? '';
    const packCode = priceIdToPack(priceId);
    if (!packCode) {
      return {
        type: 'unhandled',
        eventType: 'checkout.session.completed:unknown_pack',
        alert: `Paid credit session ${session.id} NOT granted: line-item price '${priceId}' is not a known credit pack`,
        alertDetail: { ...detail, price: priceId },
      };
    }
    const metaPrice = (session.metadata?.price_id as string | undefined) ?? null;
    const metaPack = (session.metadata?.pack_code as string | undefined) ?? null;
    if ((metaPrice && metaPrice !== priceId) || (metaPack && metaPack !== packCode)) {
      console.warn(
        `[stripe] credit session ${session.id}: metadata (price_id=${metaPrice}, pack_code=${metaPack}) disagrees with the line item (${priceId} -> ${packCode}); granting the line item`,
      );
    }

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    if (!paymentIntentId) {
      return { type: 'unhandled', eventType: 'checkout.session.completed:no_payment_intent' };
    }

    return {
      type: 'credit_purchase_completed',
      userId,
      packCode,
      providerChargeId: paymentIntentId,
      amountCents: full.amount_total ?? session.amount_total ?? 0,
      currency: session.currency ?? 'cad',
      priceId,
      promoCode: (session.metadata?.promo_code as string | undefined) ?? undefined,
      promoCodeId:
        (session.metadata?.stripe_promotion_code_id as string | undefined) || undefined,
      // Carried for the webhook's defensive users-row upsert when the
      // handle_new_user trigger has not caught up — see ensureUserRow.
      customerEmail: session.customer_email ?? session.customer_details?.email ?? null,
      providerCustomerId: _customerId(session.customer),
    };
  }

  async listInvoices(customerId: string): Promise<BillingInvoice[]> {
    const page = await getClient().invoices.list({ customer: customerId, limit: 50 });
    return page.data.map((inv) => ({
      providerInvoiceId: inv.id,
      amountCents: inv.amount_paid,
      currency: inv.currency,
      paidAt: inv.status_transitions.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000)
        : null,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    }));
  }

  /** Resolve a customer-facing promo code to its Stripe promotion_code id.
   *  Returns null on not-found / inactive / Stripe error so checkout degrades
   *  gracefully to "no promo audit key" instead of failing. */
  async resolvePromotionCodeId(code: string): Promise<string | null> {
    try {
      const res = await getClient().promotionCodes.list({ code, active: true, limit: 1 });
      const pc = res.data[0];
      return pc && pc.active !== false ? pc.id : null;
    } catch (err) {
      console.error(
        '[stripe] resolvePromotionCodeId failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  async applyPromoCode(_sessionId: string, _code: string): Promise<void> {
    // No-op: Stripe Checkout Sessions allow promo codes to be applied by the
    // END USER on the hosted page (allow_promotion_codes: true at create time).
    // There's no API to attach a code to an existing session server-side.
    // Interface kept for parity with Paddle. Per TSD §1.5a V3-C9.
  }
}

// Test-only reset.
export function _resetStripeClientForTests(): void {
  _client = null;
  _warnedAboutSecretKey = false;
}
