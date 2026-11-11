// smoke_session.mjs — mint a real Supabase Auth session for the staging smoke
// test WITHOUT a password grant, so that Supabase Auth's built-in captcha
// protection can stay switched on.
//
// WHY THIS EXISTS
// ---------------
// There are two independent hCaptcha layers in this product and they are easy
// to conflate:
//
//   1. The APP's own bot challenge — apps/web/src/lib/hcaptcha.ts,
//      verifyHcaptchaToken() against https://hcaptcha.com/siteverify with
//      HCAPTCHA_SECRET_KEY. Fails closed by design. NOT what blocked us.
//
//   2. Supabase AUTH's built-in captcha — Dashboard > Authentication > Attack
//      Protection > Captcha protection. When on, every request to
//      POST /auth/v1/token?grant_type=password must carry a captchaToken or
//      GoTrue rejects it with:
//        400 {"error_code":"captcha_failed",
//             "msg":"captcha protection: request disallowed
//                    (no captcha_token found)"}
//
// Nightly staging smoke failed five consecutive nights (Nov 7-10 2026) at step
// 3b on layer 2. A script cannot solve a captcha, and that setting is
// legitimate production hardening we want to keep, so the password grant can
// never work here. Instead we mint the session through the ADMIN API, which is
// authenticated by the service-role key and is NOT captcha-gated:
//
//   POST /auth/v1/admin/generate_link   { type: 'magiclink', email }
//        -> 200 { hashed_token, verification_type, ... }   (sends no email)
//   POST /auth/v1/verify                { token_hash, type }
//        -> 200 { access_token, refresh_token, expires_in, expires_at,
//                 token_type, user }
//
// That second response is byte-for-byte the shape the password grant returned,
// so the caller keeps building its cookie with the existing
// sessionCookieHeader() and downstream steps are untouched.
//
// Verified against GoTrue (supabase/auth) at commit 1357a5b9 (2026-11-10):
//   - internal/api/api.go:403  POST /admin/generate_link, under the /admin
//     group whose only middleware is requireAdminCredentials — no verifyCaptcha.
//   - internal/api/api.go:270  Route("/verify") { Get, Post } — rate-limited
//     only (limiterOpts.Verify), no verifyCaptcha and no requireAuthentication.
//     The complete set of verifyCaptcha call sites in that file is lines 229
//     (/signup), 256 (/recover), 259 (/resend), 262 (/magiclink), 265 (/otp),
//     268 (/token), 329 (/passkeys/authentication/options) and 349 (/sso) —
//     neither /verify nor anything under /admin is among them.
//   - internal/api/mail.go:43  GenerateLinkResponse -> hashed_token,
//     verification_type, action_link, email_otp, redirect_to + flattened user.
//   - internal/api/mail.go:146-158 for type=magiclink on an existing user the
//     hash is stored as a RecoveryToken (CreateOneTimeToken at :158), and
//     internal/api/verify.go:662 type=magiclink looks that same token kind up,
//     so the two halves agree.
//   - internal/api/verify.go:310 verifyPost returns the session as JSON;
//     :263 is the one non-session shape and it is email_change only.
//   - internal/api/verify.go:85 token_hash must be sent ALONE: supplying email
//     or token alongside it is rejected with "Only the token_hash and type
//     should be provided".
//   - internal/tokens/service.go:111 AccessTokenResponse is the JSON shape.
//
// SECRET HYGIENE: the service-role key is read by the caller from
// process.env.SUPABASE_SERVICE_ROLE_KEY and is only ever placed in request
// headers. Every string this module puts into an Error passes through
// redactSecret(), so a response body that echoed the key back cannot leak it
// into CI logs or the step summary.

const TIMEOUT_MS = 25_000;

/**
 * Remove every occurrence of `secret` from `text`.
 *
 * Defence in depth: we never interpolate the key into a message on purpose,
 * but error messages quote response bodies, and a body is not ours to trust.
 * Short secrets are ignored so a 1-2 char value cannot blank out the message.
 */
export function redactSecret(text, secret) {
  const s = String(text ?? '');
  if (typeof secret !== 'string' || secret.length < 8) return s;
  return s.split(secret).join('[REDACTED]');
}

/** Error carrying which sub-step failed, for a legible CI line. */
export class SmokeSessionError extends Error {
  constructor(step, message) {
    super(`${step}: ${message}`);
    this.name = 'SmokeSessionError';
    this.step = step;
  }
}

/**
 * Mint a Supabase Auth session for `email` using the service role.
 *
 * @param {object}   o
 * @param {string}   o.sbUrl       Supabase project URL, no trailing slash.
 * @param {string}   o.serviceKey  process.env.SUPABASE_SERVICE_ROLE_KEY.
 * @param {string}   o.email       The smoke user's email (must already exist).
 * @param {Function} [o.fetchImpl] Injectable fetch, for tests.
 * @param {number}   [o.timeoutMs]
 * @returns {Promise<object>} The GoTrue session JSON (access_token, ...).
 * @throws {SmokeSessionError} Never containing any part of `serviceKey`.
 */
export async function mintServiceRoleSession({ sbUrl, serviceKey, email, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  // Fail closed. There is deliberately no fallback to the password grant:
  // it cannot succeed while Supabase Auth captcha protection is on, so
  // falling back would only turn a clear error into a confusing one.
  if (!serviceKey) {
    throw new SmokeSessionError(
      'service-role key',
      'SUPABASE_SERVICE_ROLE_KEY is not set. The smoke test mints its session via the Supabase Admin API '
        + '(the password grant cannot work while Supabase Auth captcha protection is enabled, which it is, '
        + 'deliberately). In CI this comes from the STAGING_SUPABASE_SERVICE_ROLE_KEY repo secret.',
    );
  }
  if (!sbUrl) throw new SmokeSessionError('service-role key', 'SUPABASE_URL is not set.');
  if (!email) throw new SmokeSessionError('service-role key', 'no email given to mint a session for.');

  const clean = (t) => redactSecret(t, serviceKey).replace(/\s+/g, ' ').slice(0, 200);

  const call = async (step, path, { headers, body }) => {
    let res;
    try {
      res = await fetchImpl(`${sbUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new SmokeSessionError(step, `POST ${path} request failed: ${clean(e?.message ?? e)}`);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON; reported below */ }
    if (!res.ok) throw new SmokeSessionError(step, `POST ${path} HTTP ${res.status}: ${clean(text) || '(empty body)'}`);
    if (json === null || typeof json !== 'object') {
      throw new SmokeSessionError(step, `POST ${path} HTTP ${res.status} returned non-JSON body: ${clean(text) || '(empty body)'}`);
    }
    return json;
  };

  // 1. Generate (do not send) a magic link for the user. Admin-authenticated,
  //    not captcha-gated. Returns the token hash GoTrue just stored.
  const link = await call('generate_link', '/auth/v1/admin/generate_link', {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: { type: 'magiclink', email },
  });
  const hashedToken = link.hashed_token;
  if (typeof hashedToken !== 'string' || !hashedToken) {
    throw new SmokeSessionError(
      'generate_link',
      `response had no usable "hashed_token" (keys: ${Object.keys(link).join(',') || 'none'})`,
    );
  }
  // generate_link rewrites type magiclink -> signup when it had to create the
  // user (mail.go:79), and the token kind it stored follows that rewrite, so
  // echo back what it tells us rather than assuming 'magiclink'.
  const verificationType = typeof link.verification_type === 'string' && link.verification_type
    ? link.verification_type
    : 'magiclink';

  // 2. Redeem the hash for a real session. Public endpoint; no Authorization
  //    header (GoTrue would read an aud claim off it) and token_hash must
  //    travel alone, per verify.go:85.
  const session = await call('verify', '/auth/v1/verify', {
    headers: { apikey: serviceKey },
    body: { token_hash: hashedToken, type: verificationType },
  });
  if (typeof session.access_token !== 'string' || !session.access_token) {
    throw new SmokeSessionError(
      'verify',
      `response had no "access_token" (keys: ${Object.keys(session).join(',') || 'none'}); `
        + `token_hash from generate_link type=${verificationType} was not redeemable`,
    );
  }
  if (typeof session.refresh_token !== 'string' || !session.refresh_token) {
    throw new SmokeSessionError(
      'verify',
      `response had an access_token but no "refresh_token"; the @supabase/ssr cookie would be unusable`,
    );
  }
  return session;
}
