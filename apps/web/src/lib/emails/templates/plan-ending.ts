// R5 — Plan ending (emails v1.2 §3 R5; service email).
//
// Trigger: cancel_at_period_end turns false -> true (a cancellation in the
// Stripe customer portal). The subscription status stays `active` and access
// lasts until period_end (effectivePlanCode keeps active while now < end), so
// the copy says the plan ends then. It does NOT say "is active. Renews …",
// which is what the old R4 sent here (E2).

import type { PlanCode } from '@/lib/billing/types';
import {
  footerFor,
  formatDateProse,
  h1,
  p,
  plainText,
  planLabel,
  shell,
  siteBaseOf,
  type RenderedEmail,
} from './shared';

export interface PlanEndingVars {
  plan_code: PlanCode;
  period_end: Date | string | null;
  /**
   * D4(a): whether the Stripe customer portal lets a user undo a cancellation.
   * Unconfirmed until Jon checks the dashboard, so the default is false and
   * the email does not promise it.
   */
  undo_available?: boolean;
  siteBase?: string;
}

export function renderPlanEnding(vars: PlanEndingVars): RenderedEmail {
  const base = siteBaseOf(vars.siteBase);
  const plan = planLabel(vars.plan_code);
  const ends = formatDateProse(vars.period_end);

  const subject = ends ? `Your ${plan} plan ends on ${ends}` : `Your stem-loops ${plan} plan won’t renew`;
  const headline = ends ? `Your ${plan} plan ends on ${ends}` : `Your ${plan} plan won’t renew`;
  const preheader = ends ? `You keep ${plan} until then.` : `You cancelled your ${plan} plan.`;

  const lead = `You cancelled your ${plan} plan, so it won’t renew.`;
  const keep = ends
    ? `You keep ${plan} until ${ends}. After that your account moves to the Free plan. Any credits you hold stay on your account.`
    : `You keep ${plan} until the end of the period you paid for. After that your account moves to the Free plan. Any credits you hold stay on your account.`;
  const paragraphs = [lead, keep];
  if (vars.undo_available) {
    paragraphs.push('If you change your mind before then, you can keep the plan from your account page.');
  }

  const cta = vars.undo_available
    ? { label: 'Keep my plan', url: `${base}/account` }
    : { label: 'Go to your account', url: `${base}/account` };
  const footer = footerFor('service');

  const html = shell({
    subject,
    preheader,
    bodyHtml: [h1(headline), ...paragraphs.map(p)].join('\n'),
    cta,
    footer,
    siteBase: base,
  });
  const text = plainText({ paragraphs, cta, footer });
  return { subject, html, text };
}
