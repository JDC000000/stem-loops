// Single source of user-facing error copy (PRD §6.2 + TSD §3.6). Rendered by error_code from
// this static map only — never interpolated from server state, never a stack trace.
//
// Copy rule (design v1.4, P7): `headline` is ONE sentence saying what happened; `action` is
// ONE sentence saying what to do. Never empty, never two sentences (test/error-copy-shape).
// Slice 1b brought the entries that broke it into line.
export const ERROR_COPY: Record<string, { headline: string; action: string }> = {
  // v1 pipeline codes
  DOWNLOAD_BLOCKED: { headline: 'YouTube is blocking us from getting this video right now.', action: 'Try again in a few minutes, or upload the file.' },
  DOWNLOAD_TIMEOUT: { headline: "We couldn't reach that video in time.", action: 'Check the link and try again.' },
  DOWNLOAD_INVALID_URL: { headline: "That doesn't look like a YouTube link.", action: 'Paste a full youtube.com or youtu.be URL.' },
  DOWNLOAD_AGE_RESTRICTED: { headline: "This video is age-restricted, so we can't get it.", action: 'Try another link, or upload the file.' },
  DOWNLOAD_PRIVATE: { headline: 'This video is private or unavailable.', action: 'Try another link, or upload the file.' },
  // Raised for provider-side failures: Replicate answering `failed`, the poll budget
  // running out, a cancelled prediction. None of those is about the song, and "Try a
  // different song" sent people away from a track that would work on a retry.
  SEPARATION_FAILED: {
    headline: "Splitting the song didn't finish, because of a problem on our end, not your song.",
    action: 'Add the same song again in a few minutes.',
  },
  EXTRACTION_FAILED: { headline: "We couldn't find a steady beat in this audio.", action: 'Try a longer song with a clear beat.' },
  UPLOAD_FAILED: { headline: "We split your song but couldn't save the stems.", action: 'Add the same song again.' },
  RATE_LIMITED: { headline: "We're busy or you've hit the limit.", action: 'Wait a moment and try again.' },
  INTERNAL_ERROR: { headline: 'Something went wrong on our end, and we have logged it.', action: 'Try again in a moment.' },
  // B8: the GLOBAL in-flight cap (admission.ts checkGlobalCapacity). Distinct from
  // RATE_LIMITED because it is not about this visitor at all — other people's songs fill
  // the queue. Returned as 503 + Retry-After: 120, which is what "a few minutes" means.
  AT_CAPACITY: {
    headline: "We're at capacity with other people's songs right now — not something you did.",
    action: 'Try again in a few minutes.',
  },

  // V3 billing codes (TSD §3.6)
  CHECKOUT_FAILED: {
    headline: "We couldn't start checkout.",
    action: 'Try again, or contact support if it keeps failing.',
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
  // LEGACY, kept so a stored error_code or an old client still resolves to
  // copy. Nothing throws it any more: TSD-V3-DELTA §1.2a (Pro/Studio
  // upload-only) was REVERSED by Jon on 2026-11-16, and every plan whose
  // catalog row lists YouTube may paste a link. The old sentence ("Credits,
  // Pro and Studio only work with files you upload.") is now false, so it is
  // not shown to anyone even here.
  PAID_LINK_INGEST_DISALLOWED: {
    headline: "We couldn't start that link.",
    action: 'Try again in a moment, or upload the audio file instead.',
  },
  PROMO_INVALID: {
    headline: "That promo code isn't valid.",
    action: 'Double-check the code or continue without one.',
  },
  BOT_CHALLENGE_FAILED: {
    headline: "We couldn't verify you're not a bot.",
    action: 'Complete the challenge again, or reload the page if it keeps failing.',
  },
};

export const DEFAULT_ERROR = ERROR_COPY.INTERNAL_ERROR;

// F72 (copy audit v1.3.1): RATE_LIMITED has two causes, and each gets its own sentence.
// Per-client: this visitor started jobs, uploads or stem fetches too quickly (lib/admission.ts
// gate 1, checkUploadRate, checkStemListRate, and the atomic INSERT's per-IP WHERE).
export const RATE_LIMITED_PER_CLIENT_MSG = "You're sending requests too fast. Wait a minute and try again.";
// Spend ceiling: the rolling 24h processing budget for the whole site is used up (gate 3).
// Not about this visitor, so it must not say they went too fast.
export const RATE_LIMITED_SPEND_CEILING_MSG =
  "We've reached today's processing limit on our end. It's not something you did. Please try again later.";

// QA track B, B-03: per-IP caps on signed-out link jobs (lib/admission.ts). Both are about
// this visitor's own usage, so they say what to do, and that signing in lifts them.
export const ANON_LINK_IN_FLIGHT_MSG =
  "You already have songs processing. Wait for one to finish, or sign in to add more.";
export const ANON_LINK_DAILY_MSG =
  "You've reached today's limit for songs without an account. Sign in to keep going, or try again tomorrow.";
// B-05: the per-IP daily cap on signed-out upload presigns (lib/admission.ts).
export const ANON_UPLOAD_DAILY_MSG =
  "You've reached today's upload limit without an account. Sign in to keep going, or try again tomorrow.";

/** A paid plan asked for link ingest its plans.services row does not list. */
export const SERVICE_NOT_IN_PLAN_MSG =
  "YouTube links aren't switched on for your plan yet. Upload the audio file instead, or try again later.";

/** Internal detail (never shown) marking a free credit holder who has spent the
 *  free monthly allowance on YouTube links. Credits fund uploads only (013
 *  trigger), and Jon capped links at the free allowance (2026-11-16, "Cap at
 *  5/month"), so the copy points them at the thing their credits do buy. */
export const LINK_CAP_CREDITS_DETAIL = 'link cap reached, credits held';
export const LINK_CAP_CREDITS_MSG =
  "You've used this month's free YouTube links. Your credits still work: upload the audio file instead.";

/** The sentence a user sees for an entitlement refusal. Never the thrown message: that can be a bare code or database text. */
export function entitlementMessage(code: string, detail?: string): string {
  if (code === 'ENTITLEMENT_UNAVAILABLE' && detail === 'quota exhausted') {
    return "You've used this month's allowance on your plan. Your account page shows when the period ends.";
  }
  // A paid plan whose catalog row does not (yet) list the link service — the
  // short window between the §1.2a-reversal deploy and migration 039. Not a
  // billing outage, so it must not borrow ENTITLEMENT_UNAVAILABLE's
  // "couldn't verify your plan" sentence.
  if (code === 'ENTITLEMENT_UNAVAILABLE' && detail === 'service not in plan') {
    return SERVICE_NOT_IN_PLAN_MSG;
  }
  if (code === 'FREE_MONTHLY_QUOTA_EXHAUSTED' && detail === LINK_CAP_CREDITS_DETAIL) {
    return LINK_CAP_CREDITS_MSG;
  }
  const c = ERROR_COPY[code] ?? DEFAULT_ERROR;
  return c.action ? `${c.headline} ${c.action}` : c.headline;
}

/**
 * Codes whose failed-job sentence comes from ERROR_COPY instead of the worker's stored
 * `error_message_user`. Deliberately an allow-list of one. The worker has subclasses that
 * share a parent's code but carry a more accurate sentence of their own (FetchPausedError,
 * LiveStreamNotSupportedError, VideoBlocklistedError, LinkUnmeasurableError, the reaper's
 * poison message), and copy-audit v1.3 (#262) edited the worker strings, not this map.
 * Letting the map win for every code it knows would replace all of those with older text.
 * Add a code here only after its ERROR_COPY entry is audited and no subclass shares it.
 */
const FAILED_JOB_COPY_OVERRIDES: ReadonlySet<string> = new Set(['SEPARATION_FAILED']);

export const FAILED_JOB_FALLBACK = "We couldn't finish this track. Try another file.";

/**
 * The sentence in a failed job's box on /jobs/[id]. For SEPARATION_FAILED (a provider
 * outage, not the song) the web map's sentence wins over the worker's "Try a different
 * song". Every other code shows the worker's stored sentence, then a generic line.
 * Never includes the error code itself.
 */
export function failedJobMessage(job: { error_code?: string | null; error_message_user?: string | null }): string {
  const code = job.error_code ?? '';
  if (FAILED_JOB_COPY_OVERRIDES.has(code)) {
    const copy = ERROR_COPY[code];
    return [copy.headline, copy.action].filter(Boolean).join(' ');
  }
  return job.error_message_user ?? FAILED_JOB_FALLBACK;
}
