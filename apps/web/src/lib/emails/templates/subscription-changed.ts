// Subscription-changed email — V3-M2 (TSD §M).
// Triggered on checkout.session.completed (mode=subscription),
// customer.subscription.updated, and customer.subscription.deleted.

import type { PlanCode, SubscriptionStatus } from '@/lib/billing/types';
import { escapeHtml, formatDateUtc, shell, type RenderedEmail } from './shared';

export interface SubscriptionChangedVars {
  plan_code: PlanCode;
  status: SubscriptionStatus;
  /** Current period end — ISO string or Date. Required for most statuses. */
  period_end: Date | string | null;
  siteBase?: string;
}

function planLabel(code: PlanCode): string {
  switch (code) {
    case 'pro':
      return 'Pro';
    case 'studio':
      return 'Studio';
    case 'free':
      return 'Free';
    default:
      return code;
  }
}

/** Human one-liner for the status — drives subject + lead paragraph. */
function statusHeadline(status: SubscriptionStatus, plan: string, periodEnd: string): {
  subject: string;
  lead: string;
} {
  switch (status) {
    case 'active':
    case 'trialing':
      return {
        subject: `Your stem-loops ${plan} plan is active`,
        lead: `Your ${plan} plan is active. Renews ${periodEnd || 'at the end of your period'}.`,
      };
    case 'past_due':
      return {
        subject: `Payment problem on your stem-loops ${plan} plan`,
        lead: `We couldn't charge your card for the latest ${plan} renewal. We'll retry automatically — please update your card in the billing portal if it keeps failing.`,
      };
    case 'canceled':
      return {
        subject: `Your stem-loops ${plan} plan was canceled`,
        lead: `Your ${plan} plan has been canceled. You'll keep access until ${periodEnd || 'the end of your paid period'}.`,
      };
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return {
        subject: `Your stem-loops ${plan} plan needs attention`,
        lead: `Your ${plan} subscription couldn't complete payment. Reopen your checkout or update your card to finish.`,
      };
    case 'paused':
      return {
        subject: `Your stem-loops ${plan} plan is paused`,
        lead: `Your ${plan} plan is paused. Resume it any time from the billing portal.`,
      };
    default:
      return {
        subject: `Your stem-loops ${plan} plan was updated`,
        lead: `We've updated your ${plan} plan. Current status: ${status}.`,
      };
  }
}

export function renderSubscriptionChanged(vars: SubscriptionChangedVars): RenderedEmail {
  const base = (vars.siteBase ?? 'https://stem-loops.com').replace(/\/+$/, '');
  const plan = planLabel(vars.plan_code);
  const periodEnd = formatDateUtc(vars.period_end);
  const { subject, lead } = statusHeadline(vars.status, plan, periodEnd);

  const html = shell(
    `
      <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(subject)}</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 16px;">${escapeHtml(lead)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
             style="font-size:14px;margin:0 0 20px;border-collapse:collapse;">
        <tr>
          <td style="color:#666;padding:4px 16px 4px 0;">Plan</td>
          <td style="padding:4px 0;"><strong>${escapeHtml(plan)}</strong></td>
        </tr>
        <tr>
          <td style="color:#666;padding:4px 16px 4px 0;">Status</td>
          <td style="padding:4px 0;"><strong>${escapeHtml(vars.status)}</strong></td>
        </tr>
        ${
          periodEnd
            ? `<tr>
          <td style="color:#666;padding:4px 16px 4px 0;">Period end</td>
          <td style="padding:4px 0;"><strong>${escapeHtml(periodEnd)}</strong></td>
        </tr>`
            : ''
        }
      </table>
      <p style="margin:0 0 24px;">
        <a href="${base}/account"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">
          Manage subscription
        </a>
      </p>
      <p style="font-size:13px;color:#777;line-height:1.5;margin:0;">
        Questions? Reply to this email.
      </p>
    `,
    `${plan} plan status: ${vars.status}`,
  );
  return { subject, html };
}
