// User-facing copy for `/login?error=<code>`.
//
// The codes are emitted by app/auth/callback/route.ts (the only producer).
// Keep the two in sync: test/login-error-copy.test.mjs fails if the callback
// can emit a code that has no entry here.

export const LOGIN_ERROR_COPY: Record<string, string> = {
  auth_callback_failed:
    'That link did not work. It may have expired, already been used, or been opened in a different browser than the one you requested it from. Request a new link and open it in the same browser.',
  // Signup-confirmation link whose code exchange failed. By the time a `code` exists the account
  // has been created, so the old "request a new link" copy was wrong here (there is no control
  // to request one). Deliberately silent on whether the email is confirmed: that is Supabase's
  // state, not something this app has read. Password sign-in works if it is; Forgot password
  // (whose link also verifies the address) covers the case where it is not.
  auth_signup_link_failed:
    'That link could not be completed here, but your account was created. Sign in with the email and password you chose. If that does not work, use Forgot password? to get a new link.',
  auth_link_expired:
    'That link has expired. Request a new one and open it as soon as it arrives.',
  // QW-6: a SIGNUP-confirmation link whose exchange failed because this browser holds no PKCE
  // verifier, i.e. it was opened in another browser, device or a mail app's in-app browser. The
  // address is confirmed by then (Supabase verifies before it redirects), so password sign-in here
  // works. Emitted by app/auth/callback/route.ts.
  auth_link_other_browser:
    'This link was opened in a different browser. Sign in with your email and password here. If that does not work, use Forgot password? to get a new link.',
  // QW-6: a one-time sign-in link (or the Google return) landed on /login?code=... and the browser
  // client's exchange produced no session, almost always because the link was requested in another
  // browser. Set by LoginForm itself (not the callback route), never sent in a URL.
  auth_signin_link_failed:
    'This link was opened in a different browser, so it could not sign you in here. Sign in with your email and password here, or ask for a new one-time link and open it in this browser.',
};

/**
 * Codes that mean "an email link could not finish in this browser". With one showing, LoginForm
 * opens the email options, prefills the address it remembered (if any) and says what happened to
 * a waiting song link.
 */
export const LINK_FAILED_CODES: ReadonlySet<string> = new Set([
  'auth_signup_link_failed',
  'auth_link_other_browser',
  'auth_signin_link_failed',
]);

/** Shown under a link-failed message when a song link was waiting but this browser does not hold it. */
export const LINK_FAILED_REPASTE = 'Your song link was saved in the other browser. After you sign in, paste it again.';
/** Shown under a link-failed message when this browser still holds the waiting song link. */
export const LINK_FAILED_LINK_KEPT = 'Your song link is still saved. It starts once you sign in.';

export const LOGIN_ERROR_FALLBACK = 'Sign-in did not complete. Please try again.';

/** Message for a `?error=` value; null when there is no error to show. */
export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(LOGIN_ERROR_COPY, code)
    ? LOGIN_ERROR_COPY[code]
    : LOGIN_ERROR_FALLBACK;
}

// ─── errors thrown while signing in, signing up or resetting (QA A-08) ────────
// The form used to render `e.message` straight from fetch() or supabase-js, so a
// network failure read "Failed to fetch" (Chromium; "NetworkError when attempting
// to fetch resource." in Firefox, "Load failed" in Safari). Every thrown error on
// those flows now goes through authErrorMessage(): network failures get the same
// offline line the tool form uses, known provider codes get plain copy, our own
// copy (an Error marked `appCopy`) passes through, and anything else gets the
// caller's fallback. Provider text is never shown.

export const AUTH_OFFLINE = 'We couldn’t reach stem-loops. Check your connection and try again.';
export const AUTH_BAD_CREDENTIALS = 'That email and password don’t match. Check them and try again, or use Forgot password?';
export const AUTH_NOT_CONFIRMED = 'Confirm your email first: open the link we sent you, then sign in.';
export const AUTH_RATE_LIMITED = 'Too many tries. Wait a minute and try again.';
export const AUTH_GENERIC = 'Something went wrong. Please try again.';

// QW-7: resend the sign-up confirmation (POST /api/auth/resend-confirmation). The success line is
// the SAME whether or not the address has an account, or one waiting for confirmation: the route
// never tells them apart (no account enumeration).
export const RESEND_CONFIRMATION_LABEL = 'Resend confirmation email';
export const RESEND_CONFIRMATION_SENT =
  'If that address has an account waiting for confirmation, a new link is on its way. Open it in this browser, and check spam if it is not there in a minute.';
export const RESEND_CONFIRMATION_FAILED = 'We couldn’t send that just now. Wait a minute and try again.';
export const RESEND_CAPTCHA_HINT = 'Complete the bot check above to resend the email.';

/** True when a thrown sign-in error is Supabase's "email not confirmed". */
export function isEmailNotConfirmed(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'email_not_confirmed';
}

/** An Error carrying copy written by this app, safe to show as is. */
export function appCopyError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { appCopy: true }, extra);
}

/** fetch() or supabase-js failing to reach the server at all (offline, DNS, captive portal, CORS). */
export function isNetworkError(err: unknown): boolean {
  const e = (err ?? {}) as { name?: unknown; message?: unknown; status?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  // supabase-js wraps a failed fetch as AuthRetryableFetchError (status 0).
  if (name === 'AuthRetryableFetchError') return true;
  if (/^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed|The Internet connection appears to be offline\.?|fetch failed)$/i.test(message.trim())) return true;
  return name === 'TypeError' && /fetch|network/i.test(message);
}

/** The line to show for an error thrown by a sign-in, sign-up or reset action. */
export function authErrorMessage(err: unknown, fallback: string = AUTH_GENERIC): string {
  if (isNetworkError(err)) return AUTH_OFFLINE;
  const e = (err ?? {}) as { appCopy?: unknown; message?: unknown; code?: unknown; status?: unknown };
  if (e.appCopy === true && typeof e.message === 'string' && e.message) return e.message;
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.status === 'number' ? e.status : 0;
  if (code === 'invalid_credentials') return AUTH_BAD_CREDENTIALS;
  if (code === 'email_not_confirmed') return AUTH_NOT_CONFIRMED;
  if (status === 429 || /^over_.*rate_limit$/.test(code)) return AUTH_RATE_LIMITED;
  return fallback;
}
