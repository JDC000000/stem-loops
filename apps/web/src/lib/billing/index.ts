// Billing provider selector. Reads BILLING_PROVIDER env (default: stripe) and
// returns the singleton provider instance. Callers use the BillingProvider
// interface — they must not import StripeProvider / PaddleProvider directly.
//
// Per TSD §1.1: swapping providers (mid-flight if Stripe freezes payouts) is
// an env change, not a code change.

import { type BillingProvider } from './types';
import { StripeProvider } from './providers/stripe';
import { PaddleProvider } from './providers/paddle';

export * from './types';

let _provider: BillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (_provider) return _provider;
  const name = (process.env.BILLING_PROVIDER ?? 'stripe').toLowerCase();
  switch (name) {
    case 'stripe':
      _provider = new StripeProvider();
      break;
    case 'paddle':
      _provider = new PaddleProvider();
      break;
    default:
      throw new Error(
        `BILLING_PROVIDER='${name}' unknown; expected 'stripe' or 'paddle'`,
      );
  }
  return _provider;
}

export function _resetBillingProviderForTests(): void {
  _provider = null;
}
