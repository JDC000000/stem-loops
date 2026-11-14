// R6 — Plan ended (emails v1.2 §3 R6; service email).
//
// Trigger: subscription_canceled, i.e. Stripe's customer.subscription.deleted.
// Stripe sends that event when the subscription has actually ENDED: either at
// the end of the period after a cancel_at_period_end, or at once on an
// immediate cancel. The webhook downgrades the entitlement in the same
// handler, so access has ended by the time this email goes out.
//
// E1: the old copy said "You'll keep access until <period_end>" here, which
// was false. A user who cancels but keeps access until period end gets R5
// (plan-ending.ts) when cancel_at_period_end turns true, not this email.

import type { PlanCode } from '@/lib/billing/types';
import {
  detailRows,
  detailText,
  footerFor,
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

export interface PlanEndedVars {
  plan_code: PlanCode;
  /** The stored current_period_end. The ended date is never later than `now`. */
  period_end: Date | string | null;
  /** Injected so the output is deterministic. */
  now: Date | string;
  /**
   * True when the account fell back to the Free plan. False when another
   * subscription of theirs still entitles them, so the email must not claim
   * the account is on Free.
   */
  on_free?: boolean;
  /** plans.monthly_job_quota for 'free'; the sentence is omitted when unknown. */
  free_quota?: number | null;
  siteBase?: string;
}

/** ended_on = the earlier of now and period_end; null when period_end is null. */
export function endedOn(periodEnd: Date | string | null, now: Date | string): Date | null {
  if (!periodEnd) return null;
  const end = new Date(periodEnd);
  const n = new Date(now);
  if (Number.isNaN(end.getTime()) || Number.isNaN(n.getTime())) return null;
  return end.getTime() < n.getTime() ? end : n;
}

export function renderPlanEnded(vars: PlanEndedVars): RenderedEmail {
  const base = siteBaseOf(vars.siteBase);
  const plan = planLabel(vars.plan_code);
  const onFree = vars.on_free !== false;

  const subject = `Your stem-loops ${plan} plan was cancelled`;
  const headline = `Your ${plan} plan has ended`;
  const preheader = onFree ? 'Your account is on the Free plan now.' : `Your ${plan} plan has ended.`;

  const lead = onFree
    ? `Your ${plan} plan has ended, and your account is on the Free plan now.`
    : `Your ${plan} plan has ended. Your other plan is unchanged.`;

  const rows: DetailRow[] = [];
  if (onFree) rows.push({ label: 'Plan', value: 'Free' });
  const ended = formatDateUtc(endedOn(vars.period_end, vars.now));
  if (ended) rows.push({ label: `${plan} ended`, value: ended });

  const freeLine =
    typeof vars.free_quota === 'number' && vars.free_quota > 0
      ? `The Free plan covers ${vars.free_quota} tracks a month. Any credits you hold stay on your account.`
      : 'Any credits you hold stay on your account.';
  const paragraphs = onFree ? [lead, detailText(rows), freeLine] : [lead, detailText(rows)];

  const cta = { label: 'Go to your account', url: `${base}/account` };
  const footer = footerFor('service');

  const bodyParts = [h1(headline), p(lead), detailRows(rows)];
  if (onFree) bodyParts.push(p(freeLine));
  const html = shell({ subject, preheader, bodyHtml: bodyParts.join('\n'), cta, footer, siteBase: base });
  const text = plainText({ paragraphs, cta, footer });
  return { subject, html, text };
}
