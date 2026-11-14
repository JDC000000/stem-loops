// R4 — Plan changed (emails v1.2 §3 R4; service email).
//
// Sent only for a real change the user should hear about:
//   - active        a re-subscriber (no stored row, or a stored `incomplete`
//                   row) whose plan is now active, when R2 did not go out
//   - switched      Pro <-> Studio while active
//   - paused        the subscription became paused
//   - active again  paused or past_due -> active
// NOT sent for a renewal (R3 covers it), `incomplete`, `past_due` (R7),
// `cancel_at_period_end` (R5) or `canceled` (R6, plan-ended.ts). The webhook
// decides which case applies; see subscriptionChangeCase() in dispatch.ts.

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

/** The statuses R4 has copy for. past_due, incomplete and canceled have none. */
export type SubscriptionChangedStatus = 'active' | 'trialing' | 'paused';

export interface SubscriptionChangedVars {
  plan_code: PlanCode;
  status: SubscriptionChangedStatus;
  /** Current period end: the renewal date while active. */
  period_end: Date | string | null;
  /** Set only for a Pro <-> Studio switch; never read from a missing row. */
  previous_plan_code?: PlanCode | null;
  /** True when the plan came back from paused or past_due. */
  resumed?: boolean;
  /** plans.monthly_job_quota for plan_code. */
  monthly_job_quota?: number | null;
  siteBase?: string;
}

const STATUS_LABEL: Record<SubscriptionChangedStatus, string> = {
  active: 'Active',
  trialing: 'Trial',
  paused: 'Paused',
};

/** "It covers 50 tracks a month and renews on 15 January 2027." or ''. */
function coverage(quota: number | null | undefined, periodEnd: Date | string | null): string {
  const parts: string[] = [];
  if (typeof quota === 'number' && quota > 0) parts.push(`covers ${quota} tracks a month`);
  const renews = formatDateProse(periodEnd);
  if (renews) parts.push(`renews on ${renews}`);
  return parts.length ? `It ${parts.join(' and ')}.` : '';
}

function copyFor(vars: SubscriptionChangedVars, plan: string): {
  subject: string;
  headline: string;
  lead: string;
} {
  const cover = coverage(vars.monthly_job_quota, vars.period_end);
  const withCover = (s: string) => (cover ? `${s} ${cover}` : s);

  if (vars.status === 'paused') {
    return {
      subject: `Your stem-loops ${plan} plan is paused`,
      headline: `Your ${plan} plan is paused`,
      lead: `Your ${plan} plan is paused, so your account uses the Free plan’s allowance until it resumes.`,
    };
  }
  const previous = vars.previous_plan_code;
  if (previous && previous !== vars.plan_code) {
    return {
      subject: `Your stem-loops plan is now ${plan}`,
      headline: `Your plan is now ${plan}`,
      lead: withCover(`Your plan changed from ${planLabel(previous)} to ${plan}.`),
    };
  }
  return {
    subject: `Your stem-loops ${plan} plan is active`,
    headline: `Your ${plan} plan is active`,
    lead: withCover(vars.resumed ? `Your ${plan} plan is active again.` : `Your ${plan} plan is active.`),
  };
}

export function renderSubscriptionChanged(vars: SubscriptionChangedVars): RenderedEmail {
  const base = siteBaseOf(vars.siteBase);
  const plan = planLabel(vars.plan_code);
  const statusLabel = STATUS_LABEL[vars.status] ?? 'Updated';
  const { subject, headline, lead } = copyFor(vars, plan);

  const rows: DetailRow[] = [
    { label: 'Plan', value: plan },
    { label: 'Status', value: statusLabel },
  ];
  const renews = formatDateUtc(vars.period_end);
  if (renews && vars.status !== 'paused') rows.push({ label: 'Renews', value: renews });

  const cta = { label: 'Manage your plan', url: `${base}/account` };
  const footer = footerFor('service');
  const preheader = `${plan} plan: ${statusLabel}`;

  const html = shell({
    subject,
    preheader,
    bodyHtml: [h1(headline), p(lead), detailRows(rows)].join('\n'),
    cta,
    footer,
    siteBase: base,
  });
  const text = plainText({ paragraphs: [lead, detailText(rows)], cta, footer });
  return { subject, html, text };
}
