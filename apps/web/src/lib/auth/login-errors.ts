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
