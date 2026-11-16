// R7 — Payment failed (emails v1.2 §3 R7; service email).
//
// Trigger: invoice_payment_failed for a RENEWAL (billing_reason
// subscription_cycle) or a mid-period plan change (subscription_update), and
// only when the webhook's past_due UPDATE matched a stored subscription. A
// failed FIRST payment (subscription_create) sends nothing: the user is still
// in Checkout and never had the plan.
//
// The grace date is computed by the dispatcher as the failed period's start +
// PAST_DUE_GRACE_MS, the same rule effectivePlanCode applies. The copy does
// not promise automatic retries: those depend on Stripe dashboard settings.

import type { PlanCode } from '@/lib/billing/types';
import {
  detailRows,
  detailText,
  footerFor,
  formatDateProse,
  formatDateUtc,
  h1,
  p,
  plainText,
  planLabel,
  shell,
  siteBaseOf,
  type DetailRow,
  type RenderedEmail,
} from './shared';

export interface PaymentFailedVars {
  plan_code: PlanCode;
  /** When paid features stop: failed period start + PAST_DUE_GRACE_MS. */
  grace_end: Date | string;
  /** Injected so the output is deterministic. */
  now: Date | string;
  /** invoice.next_payment_attempt, or null when Stripe has none scheduled. */
  next_attempt?: Date | string | null;
  siteBase?: string;
}

export function renderPaymentFailed(vars: PaymentFailedVars): RenderedEmail {
  const base = siteBaseOf(vars.siteBase);
  const plan = planLabel(vars.plan_code);
  const graceEnd = new Date(vars.grace_end);
  const inGrace = new Date(vars.now).getTime() < graceEnd.getTime();
  const graceProse = formatDateProse(graceEnd);

  const subject = `Payment failed for your ${plan} plan`;
  const preheader = inGrace
    ? `${plan} stays on until ${graceProse}. Update your card to keep it.`
    : `Update your card to get ${plan} back.`;
  const lead = `We couldn’t charge your card for your ${plan} plan renewal.`;
  const grace = inGrace
    ? `${plan} stays on until ${graceProse}. If the payment still hasn’t gone through by then, your account moves to the Free plan.`
    : 'Your account is on the Free plan until the payment goes through.';
  const fix = 'Update your card from your account page.';

  const rows: DetailRow[] = [];
  const next = formatDateUtc(vars.next_attempt ?? null);
  if (next) rows.push({ label: 'Next attempt', value: next });

  const cta = { label: 'Update your card', url: `${base}/account` };
  const footer = footerFor('service');

  const html = shell({
    subject,
    preheader,
    bodyHtml: [h1(subject), p(lead), p(grace), detailRows(rows), p(fix)].join('\n'),
    cta,
    footer,
    siteBase: base,
  });
  const text = plainText({ paragraphs: [lead, grace, detailText(rows), fix], cta, footer });
  return { subject, html, text };
}
