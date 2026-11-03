// V3 billing SKU → Stripe price ID map. Reads price IDs from env so prod and
// staging can point at different Stripe environments without a code change.
//
// Defaults are the BC sandbox (test mode) price IDs created on 2026-11-03
// (CURRENT-STATE v3-session-2). Prod sets the env vars to live mode IDs
// after the Stripe account is completed for live-mode payouts.

export type BillingSku =
  | 'credits_20'
  | 'credits_60'
  | 'credits_180'
  | 'pro_monthly'
  | 'studio_monthly';

export type SkuMode = 'payment' | 'subscription';

type SkuConfig = {
  envKey: string;
  fallback: string; // BC sandbox price id
  mode: SkuMode;
};

const SKU_TABLE: Record<BillingSku, SkuConfig> = {
  credits_20: {
    envKey: 'STRIPE_PRICE_CREDITS_20',
    fallback: 'price_1UXmVkLrVEo8Syzr4hhA6nW8',
    mode: 'payment',
  },
  credits_60: {
    envKey: 'STRIPE_PRICE_CREDITS_60',
    fallback: 'price_1UXmVlLrVEo8SyzrG2giylaj',
    mode: 'payment',
  },
  credits_180: {
    envKey: 'STRIPE_PRICE_CREDITS_180',
    fallback: 'price_1UXmVmLrVEo8SyzrZoUF64Ji',
    mode: 'payment',
  },
  pro_monthly: {
    envKey: 'STRIPE_PRICE_PRO_MONTHLY',
    fallback: 'price_1UXmVmLrVEo8SyzrzdLgw02p',
    mode: 'subscription',
  },
  studio_monthly: {
    envKey: 'STRIPE_PRICE_STUDIO_MONTHLY',
    fallback: 'price_1UXmVnLrVEo8SyzrOb1nASza',
    mode: 'subscription',
  },
};

export function isBillingSku(x: unknown): x is BillingSku {
  return typeof x === 'string' && x in SKU_TABLE;
}

export function skuToPriceId(sku: BillingSku): string {
  const cfg = SKU_TABLE[sku];
  return process.env[cfg.envKey] ?? cfg.fallback;
}

export function skuMode(sku: BillingSku): SkuMode {
  return SKU_TABLE[sku].mode;
}

/** Credits granted per one-time credit-pack purchase. 0 for subscriptions. */
export function skuToCredits(sku: BillingSku): number {
  switch (sku) {
    case 'credits_20':
      return 20;
    case 'credits_60':
      return 60;
    case 'credits_180':
      return 180;
    case 'pro_monthly':
    case 'studio_monthly':
      return 0; // subscriptions grant a capability, not credit batches
  }
}

/** Which capability a subscription SKU grants (null for credit packs). */
export function subscriptionCapability(sku: BillingSku): string | null {
  switch (sku) {
    case 'pro_monthly':
      return 'pro';
    case 'studio_monthly':
      return 'studio';
    default:
      return null;
  }
}
