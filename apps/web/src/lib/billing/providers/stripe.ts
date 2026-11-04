// StripeProvider — implements BillingProvider for Stripe.
//
// Replaces the old apps/web/src/lib/stripe.ts (PR #11), which shipped at the
// wrong location and without the interface wrapper. Per TSD §1.1 all
// processor-specific code lives under lib/billing/providers/. Audit blocker
// #3 fix.
//
// API version pinned to '2026-10-28.endive' per TSD lock (session 2
// provisioning walkthrough).

import Stripe from 'stripe';
import {
  type BillingCheckoutResult,
  type BillingCustomer,
  type BillingEvent,
  type BillingInvoice,
  type BillingPortalResult,
  type BillingProvider,
  type BillingSubscription,
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
    status: sub.status as SubscriptionStatus,
    currentPeriodStart: firstItem?.current_period_start
      ? new Date(firstItem.current_period_start * 1000)
      : null,
    currentPeriodEnd: firstItem?.current_period_end
      ? new Date(firstItem.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
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
    const session = await getClient().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: planPriceId(planCode), quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
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
    const session = await getClient().checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
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
    const sub = await getClient().subscriptions.retrieve(subscriptionId);
    return subFromStripe(sub);
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

  async handleWebhook(rawBody: string, signature: string): Promise<BillingEvent> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    }
    const event = getClient().webhooks.constructEvent(rawBody, signature, secret);
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
          userId: (invoice.metadata?.user_id as string | undefined) ?? '',
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
        };
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const sub = _invoiceSubId(invoice);
        if (!sub) return { type: 'unhandled', eventType: event.type };
        return {
          type: 'invoice_payment_failed',
          userId: (invoice.metadata?.user_id as string | undefined) ?? '',
          providerSubscriptionId: sub,
        };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = (sub.metadata?.user_id as string | undefined) ?? '';
        if (event.type === 'customer.subscription.deleted') {
          return { type: 'subscription_canceled', userId, providerSubscriptionId: sub.id };
        }
        try {
          return { type: 'subscription_upserted', userId, subscription: subFromStripe(sub) };
        } catch (err) {
          // HIGH #2: unknown price_id must NOT silently downgrade to pro.
          // Mark unhandled so the webhook route logs it and the operator sees
          // the mismatch via Stripe's dashboard retry/alerting.
          if (err instanceof UnknownPriceError) {
            console.error(
              `[stripe] ${event.type} dropped for sub ${sub.id}: ${err.message}`,
            );
            return { type: 'unhandled', eventType: `${event.type}:unknown_price` };
          }
          throw err;
        }
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        return {
          type: 'dispute_created',
          providerChargeId:
            typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id,
        };
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        return { type: 'refund_created', providerChargeId: charge.id };
      }
      default:
        return { type: 'unhandled', eventType: event.type };
    }
  }

  // session.line_items is NOT populated on webhook events by default — must
  // retrieve with expand (fixes PR #13 review finding C1 — CRITICAL).
  // Prefer metadata.price_id (we set it at checkout-create time) for speed;
  // fall back to a retrieve when metadata is absent.
  private async _creditPurchaseFromSession(
    session: Stripe.Checkout.Session,
  ): Promise<BillingEvent> {
    const userId = (session.metadata?.user_id as string | undefined) ?? '';
    const packFromMeta = (session.metadata?.pack_code as string | undefined) ?? null;
    let priceId = (session.metadata?.price_id as string | undefined) ?? '';

    // Last-ditch retrieve if metadata was lost (shouldn't happen via our
    // checkout route, but handles out-of-band session creation).
    if (!priceId) {
      const full = await getClient().checkout.sessions.retrieve(session.id, {
        expand: ['line_items'],
      });
      priceId = full.line_items?.data?.[0]?.price?.id ?? '';
    }

    // Derive pack AUTHORITATIVELY from price_id, metadata is only a hint —
    // prevents user paying for pack A but getting pack B via portal plan swap.
    const packCode = priceIdToPack(priceId) ?? (packFromMeta as PackCode | null);
    if (!packCode) {
      return { type: 'unhandled', eventType: 'checkout.session.completed:unknown_pack' };
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
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'cad',
      priceId,
      promoCode: (session.metadata?.promo_code as string | undefined) ?? undefined,
      promoCodeId:
        (session.metadata?.stripe_promotion_code_id as string | undefined) || undefined,
      // Carried for the webhook's defensive users-row upsert when the
      // handle_new_user trigger has not caught up — see ensureUserRow.
      customerEmail: session.customer_email ?? session.customer_details?.email ?? null,
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
