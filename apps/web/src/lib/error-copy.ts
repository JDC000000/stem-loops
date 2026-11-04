// Single source of user-facing error copy (PRD §6.2 + TSD §3.6). Rendered by error_code from
// this static map only — never interpolated from server state, never a stack trace.
export const ERROR_COPY: Record<string, { headline: string; action: string }> = {
  // v1 pipeline codes
  DOWNLOAD_BLOCKED: { headline: 'YouTube is temporarily blocking automated access for this video.', action: 'Try again in a few minutes.' },
  DOWNLOAD_TIMEOUT: { headline: "We couldn't reach that video in time.", action: 'Check the link and try again.' },
  DOWNLOAD_INVALID_URL: { headline: "That doesn't look like a YouTube link.", action: 'Paste a full youtube.com or youtu.be URL.' },
  DOWNLOAD_AGE_RESTRICTED: { headline: "This video is age-restricted and can't be processed.", action: '' },
  DOWNLOAD_PRIVATE: { headline: 'This video is private or unavailable.', action: '' },
  SEPARATION_FAILED: { headline: 'Stem separation failed for this track.', action: 'Try a different song.' },
  EXTRACTION_FAILED: { headline: "We couldn't find clean loops in this audio.", action: 'It may be too short or beatless.' },
  UPLOAD_FAILED: { headline: "We separated your stems but couldn't save them.", action: 'Please retry.' },
  RATE_LIMITED: { headline: "We're busy or you've hit the limit.", action: 'Wait a moment and try again.' },
  INTERNAL_ERROR: { headline: "Something went wrong on our end. We've logged it.", action: 'Please try again.' },

  // V3 billing codes (TSD §3.6)
  CHECKOUT_FAILED: {
    headline: "We couldn't start checkout.",
    action: 'Please try again, or contact support if it keeps failing.',
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
    headline: "You've used all 3 songs in your free trial.",
    action: 'Pick a plan or buy a credit pack to keep going.',
  },
  CREDITS_DEPLETED: {
    headline: "You're out of credits.",
    action: 'Buy a pack of credits to process more songs.',
  },
  PROMO_INVALID: {
    headline: "That promo code isn't valid.",
    action: 'Double-check the code or continue without one.',
  },
};

export const DEFAULT_ERROR = ERROR_COPY.INTERNAL_ERROR;
