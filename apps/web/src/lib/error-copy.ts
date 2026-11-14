// Single source of user-facing error copy (PRD §6.2 + TSD §3.6). Rendered by error_code from
// this static map only — never interpolated from server state, never a stack trace.
export const ERROR_COPY: Record<string, { headline: string; action: string }> = {
  // v1 pipeline codes
  DOWNLOAD_BLOCKED: { headline: 'YouTube is temporarily blocking automated access for this video.', action: 'Try again in a few minutes.' },
  DOWNLOAD_TIMEOUT: { headline: "We couldn't reach that video in time.", action: 'Check the link and try again.' },
  DOWNLOAD_INVALID_URL: { headline: "That doesn't look like a YouTube link.", action: 'Paste a full youtube.com or youtu.be URL.' },
  DOWNLOAD_AGE_RESTRICTED: { headline: "This video is age-restricted and can't be processed.", action: '' },
  DOWNLOAD_PRIVATE: { headline: 'This video is private or unavailable.', action: '' },
  // Raised for provider-side failures: Replicate answering `failed`, the poll budget
  // running out, a cancelled prediction. None of those is about the song, and "Try a
  // different song" sent people away from a track that would work on a retry.
  SEPARATION_FAILED: {
    headline: 'Stem separation didn\u2019t finish.',
    action: 'That was a problem on our side, not your song. Please try the same track again in a few minutes.',
  },
  EXTRACTION_FAILED: { headline: "We couldn't find clean loops in this audio.", action: 'It may be too short or beatless.' },
  UPLOAD_FAILED: { headline: "We separated your stems but couldn't save them.", action: 'Please retry.' },
  RATE_LIMITED: { headline: "We're busy or you've hit the limit.", action: 'Wait a moment and try again.' },
  INTERNAL_ERROR: { headline: "Something went wrong on our end. We've logged it.", action: 'Please try again.' },
  // B8: the GLOBAL in-flight cap (admission.ts checkGlobalCapacity). Distinct from
  // RATE_LIMITED because it is not about this visitor at all — other people's songs fill
  // the queue. Returned as 503 + Retry-After: 120, which is what "a few minutes" means.
  AT_CAPACITY: {
    headline: "We're at capacity right now.",
    action: "It's not something you did — we're working through other people's songs. Please try again in a few minutes.",
  },

  // V3 billing codes (TSD §3.6)
  CHECKOUT_FAILED: {
    headline: "We couldn't start checkout.",
    action: 'Please try again, or contact support if it keeps failing.',
  },
  UNAUTHENTICATED: {
    headline: 'Sign in to continue.',
    action: 'Create an account or sign in to access billing.',
  },
  NO_CUSTOMER: {
    headline: 'No billing account yet.',
    action: 'Make a purchase first — the billing portal opens after your first checkout.',
  },
  ENTITLEMENT_UNAVAILABLE: {
    headline: "We couldn't verify your plan right now.",
    action: 'Refresh in a moment — your access will be back as soon as billing is reachable.',
  },
  PLAN_NOT_FOUND: {
    headline: "We couldn't find that plan.",
    action: 'Head back to pricing and pick a plan.',
  },
  TRIAL_EXHAUSTED: {
    headline: "You've used all the tracks in your free trial.",
    action: 'Pick a plan or buy a credit pack to keep going.',
  },
  CREDIT_BALANCE_INSUFFICIENT: {
    headline: "You're out of credits.",
    action: 'Buy a credit pack to add more tracks.',
  },
  FREE_MONTHLY_QUOTA_EXHAUSTED: {
    headline: "You've used all your free tracks this month.",
    action: 'Your allowance resets at the start of next month.',
  },
  // The action line used to read "Paste a link into the free tier (3/day)".
  // There has never been a 3/day limit anywhere in the system: the free
  // allowance is plans.monthly_job_quota, enforced per CALENDAR MONTH by
  // checkMonthlyQuota(), and migration 034 sets it to 5. A number and a period
  // that are both wrong are worse than no number, and any figure hardcoded
  // here goes stale the next time the catalog is re-priced — so this copy now
  // names the tier and the place the real number is shown, and nothing else.
  PAID_LINK_INGEST_DISALLOWED: {
    // Also named Studio: enforceEntitlement() throws this for plan_code 'pro'
    // AND 'studio', but the headline listed only Pro, so a Studio subscriber
    // hit an error that did not mention their plan.
    headline: 'Credits, Pro and Studio only work with files you upload.',
    action: 'Upload the audio file instead. YouTube links work on the Free plan.',
  },
  PROMO_INVALID: {
    headline: "That promo code isn't valid.",
    action: 'Double-check the code or continue without one.',
  },
  BOT_CHALLENGE_FAILED: {
    headline: "We couldn't verify you're not a bot.",
    action: 'Complete the challenge and try again. If it keeps failing, reload the page.',
  },
};

export const DEFAULT_ERROR = ERROR_COPY.INTERNAL_ERROR;

/** The sentence a user sees for an entitlement refusal. Never the thrown message: that can be a bare code or database text. */
export function entitlementMessage(code: string, detail?: string): string {
  if (code === 'ENTITLEMENT_UNAVAILABLE' && detail === 'quota exhausted') {
    return 'You’ve used this month’s allowance on your plan. Your account page shows when the period ends.';
  }
  const c = ERROR_COPY[code] ?? DEFAULT_ERROR;
  return c.action ? `${c.headline} ${c.action}` : c.headline;
}

/**
 * The sentence in a failed job's box on /jobs/[id]. This map wins when it knows the
 * code; the worker's stored `error_message_user` is the fallback for codes it does not
 * (UPLOAD_INVALID, UPLOAD_TOO_LONG with its limit, …), and a generic line after that.
 * Before this, the page rendered the worker's sentence verbatim, so a copy fix here
 * never reached the one page where a failed job is shown.
 */
export function failedJobMessage(job: { error_code?: string | null; error_message_user?: string | null }): string {
  const code = job.error_code ?? '';
  const copy = Object.prototype.hasOwnProperty.call(ERROR_COPY, code) ? ERROR_COPY[code] : null;
  if (copy) return [copy.headline, copy.action].filter(Boolean).join(' ');
  return job.error_message_user ?? 'We couldn’t finish this track. Try another file.';
}
