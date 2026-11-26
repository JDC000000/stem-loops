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
  // QA-61: our proxy refused or failed the fetch (e.g. expired proxy credentials, HTTP 407).
  // Ours, not YouTube's and not the user's. No credit/refund wording: link jobs never spend a
  // credit. Whether the monthly song came back is not fixed copy (QA-64): the worker appends
  // a USAGE_RETURNED_SENTENCES line to the stored message only when it actually gave the unit
  // back (not for an anonymous job, a job from before migration 042, a rolled-over month or
  // an expired trial), so it cannot be stated here, where it would be shown unconditionally.
  // The job page shows the worker's stored sentence; this entry is the API-envelope copy.
  FETCH_PROXY_FAILED: {
    headline: 'Something went wrong on our end fetching this video.',
    action: 'Try again later.',
  },
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
  // Decision 1A: a plan checkout refused because a subscription is live (HTTP 409).
  // Mirrors lib/billing/checkout-guard.ts PLAN_ALREADY_ACTIVE_COPY.live (pinned by
  // test/checkout-live-sub-block.test.mjs).
  // B-8w "P": POST /api/billing/checkout while BILLING_CHECKOUT_ENABLED is not 'true' (HTTP 403).
  CHECKOUT_DISABLED: {
    headline: 'Checkout is not open during the beta.',
    action: 'Keep using the app for free while the beta runs.',
  },
  PLAN_ALREADY_ACTIVE: {
    headline: 'You already have a plan.',
    action: 'To change or cancel it, use Manage subscription on your Account page.',
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

// ── Beta: checkout hidden (#453, follows B-8w "P" / #455) ─────────────────────────────────
// While checkout is off, nothing may tell a user to buy. ERROR_COPY above keeps the
// checkout-ON sentences (they come back on their own when checkout reopens); these replace
// them while it is off. Same one-sentence + one-sentence shape (test/error-copy-shape).
export const CHECKOUT_OFF_COPY: Readonly<Record<string, { headline: string; action: string }>> = {
  TRIAL_EXHAUSTED: {
    headline: "You've used all the tracks in your free trial.",
    action: "Plans aren't on sale during the beta, so check back after it ends.",
  },
  CREDIT_BALANCE_INSUFFICIENT: {
    headline: "You're out of credits.",
    action: "Credit packs aren't on sale during the beta, so check back after it ends.",
  },
};

/**
 * Whether checkout is on, read per call. The SAME rule as lib/billing/checkout-switch.ts
 * isCheckoutEnabled(): only the exact string 'true' in BILLING_CHECKOUT_ENABLED. Inlined, not
 * imported, because this module is loaded standalone by a dozen tests (transpiled into a
 * data: URL, where a relative import cannot resolve); test/error-copy-checkout-off.test.mjs
 * pins it to checkout-switch.ts. A server variable: in a browser bundle it reads as off,
 * and no client component renders these two codes (they come from API routes).
 */
export function checkoutEnabledNow(): boolean {
  return typeof process !== 'undefined' && process.env?.BILLING_CHECKOUT_ENABLED === 'true';
}

/** The copy for a code in the current checkout posture. */
export function errorCopy(code: string, checkoutEnabled: boolean = checkoutEnabledNow()): { headline: string; action: string } {
  if (!checkoutEnabled && CHECKOUT_OFF_COPY[code]) return CHECKOUT_OFF_COPY[code];
  return ERROR_COPY[code] ?? DEFAULT_ERROR;
}

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
export const ANON_JOB_IN_FLIGHT_MSG =
  "You already have songs processing. Wait for one to finish, or sign in to add more.";
export const ANON_JOB_DAILY_MSG =
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
  const c = errorCopy(code);
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
 * QA-64. The sentence the worker appends to a failed job's stored `error_message_user` when,
 * and only when, it gave back the monthly-allowance unit or trial song that job spent
 * (worker/job_failure.py ALLOWANCE_RETURNED_SENTENCE / TRIAL_RETURNED_SENTENCE, pinned
 * identical by test/allowance-restore.test.mjs). Its presence in the stored message IS
 * the record that it is true for this job, so the job page may repeat it, and never adds it
 * on its own.
 */
export const USAGE_RETURNED_SENTENCES: readonly string[] = [
  "This didn't count toward your monthly songs.",
  "This didn't use one of your trial songs.",
];

/**
 * The sentence in a failed job's box on /jobs/[id]. For SEPARATION_FAILED (a provider
 * outage, not the song) the web map's sentence wins over the worker's "Try a different
 * song". Every other code shows the worker's stored sentence, then a generic line.
 * When the map wins, a USAGE_RETURNED_SENTENCES line the worker stored is kept (QA-64): it
 * is there only when it is true for this job, and replacing the message must not drop it.
 * Never includes the error code itself.
 */
export function failedJobMessage(job: { error_code?: string | null; error_message_user?: string | null }): string {
  const code = job.error_code ?? '';
  if (FAILED_JOB_COPY_OVERRIDES.has(code)) {
    const copy = ERROR_COPY[code];
    const stored = job.error_message_user ?? '';
    const returned = USAGE_RETURNED_SENTENCES.find((s) => stored.endsWith(s));
    return [copy.headline, copy.action, returned].filter(Boolean).join(' ');
  }
  return job.error_message_user ?? FAILED_JOB_FALLBACK;
}

// ── "Try again" on a failed link song (#321; Phase B, B3) ──────────────────────────────────
// The failed-job box's own retry button. Its label differs from the poll panel's "Try again"
// (that one re-asks the server; this one starts the song again as a new job).
export const RETRY_BUTTON_LABEL = 'Try this song again';
/** What a retry spends, said before the tap. A charged retry spends only what came back. */
export const RETRY_COST_FREE = "This try is on us. It won't count toward your songs.";
export const RETRY_COST_CHARGED = 'This uses 1 of your songs, the one we gave back when this try failed.';
/** 429 from POST /api/jobs/:id/retry once a song has used its retries (cap 2, Jon D7). */
export const RETRY_LIMIT_MSG = "You've tried this song again twice. Paste the link again later to start it fresh.";
/** The job was already retried (a second tab): the button is replaced by a link to that try. */
export const RETRY_ALREADY_MSG = 'You already tried this song again.';
export const RETRY_GO_TO_LABEL = 'Go to the new try';
/** On a retry's own page, before the link to the job it retries. */
export const RETRY_OF_LABEL = 'Retry of';
export const RETRY_OF_LINK_TEXT = 'your earlier try';
/** A failed upload: its file is gone with the job, so the way back is a fresh upload. */
export const UPLOAD_AGAIN_LABEL = 'Upload again';
export const UPLOAD_AGAIN_MSG = "We can't try an uploaded file again. Upload it again to start over.";
/** RATE_LIMITED parent still cooling down. */
export const RETRY_COOLDOWN_MSG = 'Wait a minute, then try this song again.';
/** 402 from a retry whose given-back trial song has been used since. Credit packs never fund a
 *  link (013 trigger), so this does not offer one, unlike the generic TRIAL_EXHAUSTED line. */
export const RETRY_TRIAL_USED_MSG = "The trial song we gave back has been used since, so this one can't be tried again. Pick a plan to keep adding songs.";
