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
};

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
