// R2 — Welcome, subscriber (emails v1.2 §3 R2; service email).
// Trigger: the first subscription_upserted with status active or trialing,
// guarded by users.welcomed_at (migration 019). See dispatch.ts.
//
// A service email: no pricing link and no prompt to buy (D3, §2.8).

import type { PlanCode } from '@/lib/billing/types';
import { CHORDS_LINE_SHOWN } from '@/lib/chords-claim';
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
  /** plans.monthly_job_quota for plan_code (Pro 50, Studio 150; migration 034). Read from the row
   *  by dispatch.ts, never typed here, so the email cannot drift from the catalog. */
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
  // DB-17 (lib/chords-claim.ts): no chord claim when the switch is off.
  // C-13 (QA 2026-11-18): the old second sentence, "Pro and Studio work with audio files you
  // upload.", has been false since 2026-11-16 (migration 039 gave Pro and Studio YouTube links).
  // It is dropped rather than replaced: whether links are accepted also depends on the
  // ALLOW_YOUTUBE_INPUT rollout switch, which this email cannot see, and /pricing already says
  // what each plan takes. "Add a song" is true for a file and for a link.
  const how = CHORDS_LINE_SHOWN
    ? 'Add a song and it opens in the player: six stems on faders, with a chord track to play along to.'
    : 'Add a song and it opens in the player: six stems on faders, to play along to.';
  // #270: songs over 5 minutes are trimmed to their first 5 minutes, not refused.
  // Paid-plan retention (Jon, 2026-11-15). Source of truth: 30 days = PAID_RETENTION_GRACE_DAYS
  // (lib/retention.ts); 5 minutes = MAX_TRACK_SEC (lib/play/types.ts). This email goes to
  // subscribers only. Pinned by test/chords-switch-surfaces.test.mjs ("numeric claims").
  const limits = `Songs longer than 5${NB}minutes use the first 5${NB}minutes. Your songs stay in your library while you are subscribed, and for 30${NB}days after your plan ends.`;
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
