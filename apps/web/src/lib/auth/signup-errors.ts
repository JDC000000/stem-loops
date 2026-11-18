// What POST /api/auth/signup says when supabase.auth.signUp() returns an error (Slice 1b).
//
// The route used to send `error.message` straight to the browser, so a person signing up again
// with an address that already has a confirmed account read Supabase's raw "Error sending
// confirmation email". Provider text is now NEVER shown: every error maps to one plain line.
//
// What signUp() returns, by case (auth-js 2.117, GoTrue; AuthApiError has `status` and `code`):
//   - confirmation email could not be sent (SMTP failure, or the resend GoTrue attempts for
//     an address it already knows): status 500, code `unexpected_failure`, message
//     "Error sending confirmation email";
//   - email send rate limit: 429, `over_email_send_rate_limit`;
//   - request rate limit: 429, `over_request_rate_limit`;
//   - address already registered (only when confirmations are off): 422, `user_already_exists`
//     or `email_exists`;
//   - weak password (the server-side policy): 422, `weak_password`;
//   - address refused by the mail setup: 400, `email_address_invalid` / `email_address_not_authorized`;
//   - sign-ups switched off: 422, `signup_disabled` / `email_provider_disabled`.
//
// The existing-account, send-failure and rate-limit cases all get the SAME line, so the
// response says nothing about whether an account exists that Supabase's own flow (a
// confirmation email, or none) does not already say. It offers a Sign in link (`sign_in: true`).
//
// Server failures ARE reported (review round 2, SF-1). GoTrue uses `unexpected_failure` for
// EVERY 500 it returns — SMTP failure, but also "Database error saving new user" and auth-hook
// failures — so that code, or any status >= 500, means sign-up may be down. The person still
// gets the neutral retry/sign-in line, but `report` is 'server_failure' and the route sends
// Sentry the code and status only: never the provider message, never the address.
//
// Pure, so test/signup-email-and-errors.test.mjs loads it directly.

export const SIGNUP_RETRY_OR_SIGN_IN = 'If you already have an account, sign in instead — or wait a minute and try again.';
export const SIGNUP_WEAK_PASSWORD = 'That password is too easy to guess — choose a different one.';
export const SIGNUP_EMAIL_REFUSED = "We can't send email to that address — check it and try again.";
export const SIGNUP_DISABLED = 'Sign-up is paused right now — try again later.';
export const SIGNUP_GENERIC = "We couldn't create your account just now — try again in a minute.";

export type SignupErrorReply = {
  code: 'SIGNUP_RETRY_OR_SIGN_IN' | 'SIGNUP_WEAK_PASSWORD' | 'SIGNUP_EMAIL_REFUSED' | 'SIGNUP_DISABLED' | 'SIGNUP_FAILED';
  error: string;
  /** Show a "Sign in" link beside the message. */
  sign_in: boolean;
  status: number;
  /** True when this should reach Sentry (code and status only): `report` is not null. */
  unexpected: boolean;
  /** Why it is reported: an unmapped error, or a server failure (5xx / `unexpected_failure`). */
  report: 'unmapped' | 'server_failure' | null;
};

const RETRY_OR_SIGN_IN_CODES = new Set([
  'user_already_exists',
  'email_exists',
  'identity_already_exists',
  'over_email_send_rate_limit',
  'over_request_rate_limit',
  'unexpected_failure',
]);

/** A Sentry-safe tag for the provider's error code: GoTrue codes are snake_case identifiers,
 *  so anything else (free text, an address) is replaced rather than forwarded. */
export function safeAuthCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : code == null || code === '' ? '' : 'other';
}

/** Map a signUp() error to a reply. Reads only `code`, `status` and (as a last resort) whether
 *  the message is about the confirmation email; never copies any of it into the reply. */
export function signupErrorReply(err: unknown): SignupErrorReply {
  const e = (err ?? {}) as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.status === 'number' ? e.status : 0;
  const message = typeof e.message === 'string' ? e.message : '';
  const serverFailure = code === 'unexpected_failure' || status >= 500;
  const known = serverFailure
    ? ({ unexpected: true, report: 'server_failure' } as const)
    : ({ unexpected: false, report: null } as const);

  if (
    RETRY_OR_SIGN_IN_CODES.has(code) ||
    status === 429 ||
    /confirmation email|sending .*email|rate limit/i.test(message)
  ) {
    return { code: 'SIGNUP_RETRY_OR_SIGN_IN', error: SIGNUP_RETRY_OR_SIGN_IN, sign_in: true, status: 400, ...known };
  }
  if (code === 'weak_password') {
    return { code: 'SIGNUP_WEAK_PASSWORD', error: SIGNUP_WEAK_PASSWORD, sign_in: false, status: 400, ...known };
  }
  if (code === 'email_address_invalid' || code === 'email_address_not_authorized') {
    return { code: 'SIGNUP_EMAIL_REFUSED', error: SIGNUP_EMAIL_REFUSED, sign_in: false, status: 400, ...known };
  }
  if (code === 'signup_disabled' || code === 'email_provider_disabled') {
    return { code: 'SIGNUP_DISABLED', error: SIGNUP_DISABLED, sign_in: false, status: 400, ...known };
  }
  return { code: 'SIGNUP_FAILED', error: SIGNUP_GENERIC, sign_in: false, status: 400,
    unexpected: true, report: serverFailure ? 'server_failure' : 'unmapped' };
}
