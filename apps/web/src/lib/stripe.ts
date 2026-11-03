// Stripe client — V3 billing, Phase 1a.
//
// Design
// ------
// * API version pinned to `2026-10-28.endive` per the V3 TSD. A pinned
//   version means a Stripe server-side release never silently changes the
//   shape of responses we parse; version bumps are intentional PRs.
// * Lazy singleton: the client is built on first call, not at module import,
//   so Next.js build-time evaluation of this module (e.g. tree-shaking or
//   preview-renders) never trips on a missing STRIPE_SECRET_KEY.
// * Instance pattern (`new Stripe(key, config)`), never the deprecated
//   `Stripe.setApiKey` / module-level global — per Stripe best-practices
//   skill for @stripe/stripe-node v23+.
// * Prefers a restricted API key (RAK, `rk_` prefix) over a secret key
//   (`sk_`). We log a one-time warning if an `sk_` key is seen so dev
//   environments still work but prod regressions get noticed.
// * telemetry: false — we don't send Stripe request timing from our server.
// * appInfo — surfaces "stem-loops / <version>" in Stripe Dashboard event
//   metadata so support can tell OUR requests from any other integration.

import Stripe from 'stripe';

export const STRIPE_API_VERSION = '2026-10-28.endive' as const;

let _client: Stripe | null = null;
let _warnedAboutSecretKey = false;

/**
 * Return a singleton Stripe client. Throws if STRIPE_SECRET_KEY is unset,
 * so the caller gets a clear failure at request time (not a silent null).
 *
 * Usage:
 *   import { getStripe } from '@/lib/stripe';
 *   const stripe = getStripe();
 *   const session = await stripe.checkout.sessions.create({ ... });
 */
export function getStripe(): Stripe {
  if (_client) return _client;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. In Vercel: add it to the project env ' +
        '(use a restricted API key — `rk_` prefix — not a secret key).',
    );
  }

  if (!key.startsWith('rk_') && !key.startsWith('sk_')) {
    throw new Error(
      `STRIPE_SECRET_KEY has an unexpected prefix: expected "rk_" or "sk_", got "${key.slice(0, 3)}…"`,
    );
  }

  if (key.startsWith('sk_') && !_warnedAboutSecretKey) {
    // Warn once, don't spam logs per request. Use console.warn so Sentry
    // can forward it if configured.
    console.warn(
      '[stripe] STRIPE_SECRET_KEY uses an sk_ prefix — prefer a restricted ' +
        'API key (rk_) in production. See docs.stripe.com/keys#restricted.',
    );
    _warnedAboutSecretKey = true;
  }

  _client = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    telemetry: false,
    appInfo: {
      name: 'stem-loops',
      version: '3.0.0-dev',
      url: 'https://stem-loops.com',
    },
    // The SDK default is 2 automatic retries on retryable errors (5xx /
    // timeout / ECONNRESET). Leave at default — enough for a single-digit
    // probability transient without making webhook latency unpredictable.
  });

  return _client;
}

/**
 * Test-only: drop the cached client so the next getStripe() rebuilds.
 * Never called in production code paths.
 */
export function _resetStripeClientForTests(): void {
  _client = null;
  _warnedAboutSecretKey = false;
}
