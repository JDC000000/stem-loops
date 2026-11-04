// PaddleProvider — stub for Phase 1a.
//
// Per TSD §1.1 (LOCKED per Jon 2026-11-02T22:45): "Paddle adapter as working
// code (NOT just an interface) from Day 1" — the StripeProvider and
// PaddleProvider both exist from day one, but Paddle's implementation is
// deferred to Phase 1b. The class must EXIST so the discriminator-based
// swap is a config change, not a code deploy; its methods throw until a
// Phase 1b PR fills them in.
//
// Audit note: this satisfies the "exists from Day 1" letter of the spec but
// NOT the "working code" part — Phase 1b has to ship a real implementation
// before we can honor the accepted-risk S4 fallback. Flagged in the PR body.

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
  NotImplementedError,
} from '../types';

export class PaddleProvider implements BillingProvider {
  readonly name = 'paddle' as const;

  async createCustomer(_userId: string, _email: string): Promise<BillingCustomer> {
    throw new NotImplementedError('createCustomer');
  }
  async createCheckoutSession(
    _userId: string,
    _planCode: PlanCode,
    _successUrl: string,
    _cancelUrl: string,
    _promoCode?: string | null,
  ): Promise<BillingCheckoutResult> {
    throw new NotImplementedError('createCheckoutSession');
  }
  async createCreditPurchaseSession(
    _userId: string,
    _pack: PackCode,
    _successUrl: string,
    _cancelUrl: string,
    _promoCode?: string | null,
  ): Promise<BillingCheckoutResult> {
    throw new NotImplementedError('createCreditPurchaseSession');
  }
  async createPortalSession(
    _customerId: string,
    _returnUrl: string,
  ): Promise<BillingPortalResult> {
    throw new NotImplementedError('createPortalSession');
  }
  async getSubscription(_subscriptionId: string): Promise<BillingSubscription> {
    throw new NotImplementedError('getSubscription');
  }
  async cancelSubscription(
    _subscriptionId: string,
    _atPeriodEnd: boolean,
  ): Promise<void> {
    throw new NotImplementedError('cancelSubscription');
  }
  async handleWebhook(_rawBody: string, _signature: string): Promise<BillingEvent> {
    throw new NotImplementedError('handleWebhook');
  }
  async listInvoices(_customerId: string): Promise<BillingInvoice[]> {
    throw new NotImplementedError('listInvoices');
  }
  async applyPromoCode(_sessionId: string, _code: string): Promise<void> {
    throw new NotImplementedError('applyPromoCode');
  }
}
