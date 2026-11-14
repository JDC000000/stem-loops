// R2 — Welcome, subscriber (emails v1.2 §3 R2; service email).
// Trigger: the first subscription_upserted with status active or trialing,
// guarded by users.welcomed_at (migration 019). See dispatch.ts.
//
// A service email: no pricing link and no prompt to buy (D3, §2.8).

import type { PlanCode } from '@/lib/billing/types';
import {
  footerFor,
  formatDateProse,
  h1,
  link,
  p,
  pHtml,
  plainText,
  planLabel,
  shell,
  siteBaseOf,
  type RenderedEmail,
} from './shared';

export interface WelcomeVars {
  plan_code?: PlanCode | null;
  /** The subscription's current_period_end: the renewal date. */
  period_end?: Date | string | null;
  /** plans.monthly_job_quota for plan_code (Pro 50, Studio 150; migration 034). */
  monthly_job_quota?: number | null;
  siteBase?: string;
}

const NB = ' ';

/** "Your Pro plan is active, covers 50 tracks a month and renews on 15 January 2027." */
function planSentence(vars: WelcomeVars): string {
  const plan = vars.plan_code ? `${planLabel(vars.plan_code)} plan` : 'plan';
  const parts: string[] = [];
  if (typeof vars.monthly_job_quota === 'number' && vars.monthly_job_quota > 0) {
    parts.push(`covers ${vars.monthly_job_quota} tracks a month`);
  }
  const renews = formatDateProse(vars.period_end);
  if (renews) parts.push(`renews on ${renews}`);
  if (parts.length === 0) return `Your ${plan} is active.`;
  if (parts.length === 1) return `Your ${plan} is active and ${parts[0]}.`;
  return `Your ${plan} is active, ${parts[0]} and ${parts[1]}.`;
}

export function renderWelcome(vars: WelcomeVars = {}): RenderedEmail {
  const base = siteBaseOf(vars.siteBase);
  const subject = 'Welcome to stem-loops';
  const plan = vars.plan_code ? planLabel(vars.plan_code) : '';
  const preheader = plan
    ? `Your ${plan} plan is active. Upload a song to start.`
    : 'Your plan is active. Upload a song to start.';
  const lead = `Thanks for subscribing. ${planSentence(vars)}`;
  const how =
    'Upload a song and it opens in the player: six stems on faders, with a chord track to play along to. Pro and Studio work with audio files you upload.';
  // #270: songs over 5 minutes are trimmed to their first 5 minutes, not refused.
  const limits = `Songs longer than 5${NB}minutes use the first 5${NB}minutes, and files are deleted 24${NB}hours after the job starts.`;
  const cta = { label: 'Upload a song', url: `${base}/` };
  const footer = footerFor('service');

  const bodyHtml = [
    h1('Welcome to stem-loops'),
    p(lead),
    p(how),
    p(limits),
    pHtml(`Your plan is on your ${link(`${base}/account`, 'account page')}.`),
  ].join('\n');

  const html = shell({ subject, preheader, bodyHtml, cta, footer, siteBase: base });
  const text = plainText({
    paragraphs: [lead, how, limits, `Your plan is on your account page: ${base}/account`],
    cta,
    footer,
  });
  return { subject, html, text };
}
