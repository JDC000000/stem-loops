// User-facing copy for `/login?error=<code>`.
//
// The codes are emitted by app/auth/callback/route.ts (the only producer).
// Keep the two in sync: test/login-error-copy.test.mjs fails if the callback
// can emit a code that has no entry here.

export const LOGIN_ERROR_COPY: Record<string, string> = {
  auth_callback_failed:
    'That link did not work. It may have expired, already been used, or been opened in a different browser than the one you requested it from. Request a new link and open it in the same browser.',
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
