// smoke_session.mjs — mint a real Supabase Auth session for the staging smoke
// test without typing a captcha, so Supabase Auth's captcha protection can
// stay switched on.
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
//      Protection > Captcha protection. With it on, an ANONYMOUS request to
//      POST /auth/v1/token?grant_type=password must carry a captchaToken or
//      GoTrue rejects it with:
//        400 {"error_code":"captcha_failed",
//             "msg":"captcha protection: request disallowed
//                    (no captcha_token found)"}
//
// Nightly staging smoke failed five consecutive nights (Nov 7-10 2026) at step
// 3b on layer 2, because it signed in anonymously with the publishable key.
//
// HONEST FRAMING OF THE CHOICE (corrected 2026-11-11 after review)
// ----------------------------------------------------------------
// An earlier version of this comment claimed the password grant "can never
// work" while captcha protection is on. That is FALSE, and the GoTrue source
// says so plainly:
//
//   internal/api/middleware.go:247-258  verifyCaptcha()
//     if !config.Security.Captcha.Enabled        { return ctx, nil }
//     if _, err := a.requireAdminCredentials(...); err == nil {
//         // skip captcha validation if authorization header contains an
//         // admin role
//         return ctx, nil
//     }
//
// So sending `Authorization: Bearer <service-role key>` on the EXISTING
// password grant would also have skipped captcha, on all eight gated routes
// including /token. That is a roughly one-line alternative.
//
// This module is still the chosen approach, deliberately:
//   - It is the documented, supported admin path for obtaining a session,
//     rather than relying on a captcha-bypass side effect of sending admin
//     credentials to an endpoint designed for end users.
//   - It does not require the smoke user to have a usable password at all.
//   - It is unit-tested and mutation-checked here; the one-line alternative
//     could not be verified from this environment either (egress to
//     *.supabase.co is refused), so it is not the safer-because-smaller
//     option, only the smaller one.
// The point is that the design was CHOSEN, not FORCED. Either would work.
//
//   POST /auth/v1/admin/generate_link   { type: 'magiclink', email }
//        -> 200 { hashed_token, verification_type, ... }   (sends no email)
//   POST /auth/v1/verify                { token_hash, type }
//        -> 200 { access_token, refresh_token, expires_in, expires_at,
//                 token_type, user }
//
// That second response is byte-for-byte the shape the password grant returned,
// so the caller keeps building its cookie with the existing
// sessionCookieHeader() and downstream steps are untouched. The minted session
// is an ordinary `authenticated` user JWT -- no elevated role travels into it.
//
// Verified against GoTrue (supabase/auth) at commit 1357a5b9 (2026-11-10):
//   - internal/api/api.go:403  POST /admin/generate_link, under the /admin
//     group whose only middleware is requireAdminCredentials — no verifyCaptcha.
//   - internal/api/api.go:270  Route("/verify") { Get, Post } — rate-limited
//     only (limiterOpts.Verify), no verifyCaptcha and no requireAuthentication.
//     The complete set of verifyCaptcha call sites in that file is lines 229
//     (/signup), 256 (/recover), 259 (/resend), 262 (/magiclink), 265 (/otp),
//     268 (/token), 329 (/passkeys/authentication/options) and 349 (/sso) —
//     neither /verify nor anything under /admin is among them. Enforcement is
//     singular: config.Security.Captcha.Enabled is read at exactly one
//     non-test site, middleware.go:251, inside verifyCaptcha.
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
// SECRET HYGIENE (two mechanisms, both load-bearing)
// --------------------------------------------------
//   a) Every SmokeSessionError this module raises is built by boom(), which
//      scrubs the WHOLE message. Not just the quoted body -- the whole string.
//      An earlier version scrubbed only body *values*, and a response whose
//      object KEY was the key (`{"<key>":1}`) leaked it through
//      Object.keys().join(), as did a rejecting res.text(). Scrubbing at the
//      single construction point makes the invariant structural instead of a
//      promise repeated at each call site.
//   b) redirect: 'manual' on every request. undici follows redirects by
//      default; it strips `Authorization` cross-origin per fetch spec but does
//      NOT strip a custom `apikey` header, so a 30x from the Supabase host to
//      any other origin would hand that origin the key. Reproduced locally on
//      Node v22.23.4 with two servers: with redirect:'follow' the second
//      origin received the full apikey; with 'manual' the hop never happens.
//      A 3xx is therefore an error here, not something to follow.
//
// This module writes nothing to stdout/stderr and reads no process.env; the
// caller owns both. Tests: apps/web/test/smoke-staging-session.test.mjs.

const TIMEOUT_MS = 25_000;

/**
 * Remove every occurrence of `secret` from `text`.
 *
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
 * @param {string}   [o.anonKey]   Publishable/anon key. Used as the `apikey`
 *   on the PUBLIC /auth/v1/verify call so the service-role key is not sent to
 *   an unauthenticated endpoint. The service key is used instead when this is
 *   absent, or once as a retry if the gateway rejects this key with 401/403
 *   (a legacy anon JWT may be disabled on the project).
 * @param {string}   o.email       The smoke user's email (must already exist).
 * @param {Function} [o.fetchImpl] Injectable fetch, for tests.
 * @param {Function} [o.onNotice] Called with a human-readable string when
 *   something happened that the run should surface but that is not a failure
 *   -- currently only the anon-key fallback. This module writes nothing to
 *   stdout/stderr itself (asserted by a test), so the caller decides how to
 *   report it. Without this the fallback would be invisible: a permanently
 *   rejected anon key would silently use the service key every single run.
 * @param {number}   [o.timeoutMs]
 * @returns {Promise<object>} The GoTrue session JSON (access_token, ...).
 * @throws {SmokeSessionError} Never containing any part of either key.
 */
export async function mintServiceRoleSession({ sbUrl, serviceKey, anonKey = '', email, fetchImpl = fetch, onNotice = () => {}, timeoutMs = TIMEOUT_MS }) {
  // Scrub BOTH credentials the module holds, not just the service key.
  const scrub = (t) => redactSecret(redactSecret(t, serviceKey), anonKey);
  // For untrusted text (response bodies, foreign error messages): scrub, then
  // flatten and cap so one hostile body cannot bury the CI line.
  const clean = (t) => scrub(t).replace(/\s+/g, ' ').slice(0, 200);
  // The ONLY place this module constructs an error -- every throw below goes
  // through here, so no call site can leak a credential however it
  // interpolates. Declared before the guards so that is true without exception.
  //
  // BOTH arguments are scrubbed. `step` is a literal at all three call sites
  // today, so a credential cannot reach it through the public API -- but this
  // mechanism is sold as structural, and an unscrubbed input to the one
  // construction point is a hole in that claim rather than a live leak. A
  // review mutant that put a credential in `step` leaked it in full.
  //
  // `status` is the HTTP status, attached so callers can branch on the STATUS
  // rather than on the message. The message embeds `clean(text)`, i.e.
  // attacker-controlled response body, so any decision made by matching the
  // message is really a decision made by the remote end.
  const boom = (step, msg, status) => {
    const err = new SmokeSessionError(scrub(step), scrub(msg));
    if (typeof status === 'number') err.status = status;
    return err;
  };

  // Fail closed. There is deliberately no fallback to an anonymous password
  // grant: that is exactly what captcha protection rejects, so falling back
  // would only turn a clear error into the confusing one we are fixing.
  if (!serviceKey) {
    throw boom(
      'service-role key',
      'SUPABASE_SERVICE_ROLE_KEY is not set. The smoke test mints its session via the Supabase Admin API, '
        + 'because an anonymous password grant is rejected by Supabase Auth captcha protection (which is '
        + 'enabled deliberately). In CI this comes from the STAGING_SUPABASE_SERVICE_ROLE_KEY repo secret.',
    );
  }
  if (!sbUrl) throw boom('service-role key', 'SUPABASE_URL is not set.');
  if (!email) throw boom('service-role key', 'no email given to mint a session for.');

  const call = async (step, path, { headers, body }) => {
    let res;
    try {
      res = await fetchImpl(`${sbUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        // Never follow: a cross-origin hop would carry `apikey` with it.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw boom(step, `POST ${path} request failed: ${clean(e?.message ?? e)}`);
    }
    // Inside the try: a body-stream failure must not escape as a bare,
    // unscrubbed Error that has also lost the step label.
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw boom(step, `POST ${path} HTTP ${res.status}: could not read the response body: ${clean(e?.message ?? e)}`, res.status);
    }
    if (res.status >= 300 && res.status < 400) {
      throw boom(
        step,
        `POST ${path} returned a redirect (HTTP ${res.status}). Not followed on purpose: a cross-origin hop `
          + 'would carry the apikey header with it. Check SUPABASE_URL.',
        res.status,
      );
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON; reported below */ }
    if (!res.ok) throw boom(step, `POST ${path} HTTP ${res.status}: ${clean(text) || '(empty body)'}`, res.status);
    if (json === null || typeof json !== 'object') {
      throw boom(step, `POST ${path} HTTP ${res.status} returned non-JSON body: ${clean(text) || '(empty body)'}`, res.status);
    }
    return json;
  };

  // Response object KEYS are as untrusted as values -- see hygiene note (a).
  const keysOf = (o) => clean(Object.keys(o).join(',')) || 'none';

  // 1. Generate (do not send) a magic link for the user. Admin-authenticated,
  //    not captcha-gated. Returns the token hash GoTrue just stored.
  const link = await call('generate_link', '/auth/v1/admin/generate_link', {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: { type: 'magiclink', email },
  });
  const hashedToken = link.hashed_token;
  if (typeof hashedToken !== 'string' || !hashedToken) {
    throw boom('generate_link', `response had no usable "hashed_token" (keys: ${keysOf(link)})`);
  }
  // generate_link rewrites type magiclink -> signup when it had to create the
  // user (mail.go:79), and the token kind it stored follows that rewrite, so
  // echo back what it tells us rather than assuming 'magiclink'.
  const verificationType = typeof link.verification_type === 'string' && link.verification_type
    ? link.verification_type
    : 'magiclink';

  // 2. Redeem the hash for a real session.
  //
  //    /verify is public and unauthenticated, so it gets the LEAST privileged
  //    key that clears the Supabase gateway: the publishable/anon key when the
  //    caller has one, else the service key. No Authorization header -- the
  //    endpoint does not need one (api.go:270 has no requireAuthentication),
  //    and sending admin credentials to a public endpoint is gratuitous.
  //    (An earlier comment justified omitting it by claiming GoTrue would read
  //    an `aud` claim off it. That was wrong: helpers.go:36-38 explicitly
  //    IGNORES the aud claim for admin roles. The real reason is least
  //    privilege.)
  //
  //    token_hash must travel alone, per verify.go:85.
  const redeem = (apikey) => call('verify', '/auth/v1/verify', {
    headers: { apikey },
    body: { token_hash: hashedToken, type: verificationType },
  });

  let session;
  try {
    session = await redeem(anonKey || serviceKey);
  } catch (e) {
    // Preferring the anon key must not become a new way for the nightly to
    // fail. scripts/SMOKE-TEST-README.md warns that a LEGACY anon JWT may be
    // disabled on the project, in which case the Supabase gateway rejects the
    // call outright with 401/403 before GoTrue sees it. The service-role key
    // is known-good here (generate_link just succeeded with it), so fall back
    // exactly once on that specific signal rather than failing the whole run
    // over a key choice. Any other error -- including a real token problem --
    // propagates untouched.
    //
    // The test is on err.status, NOT on err.message. An earlier version
    // matched / HTTP 40[13]:/ against the message, and the message embeds
    // clean(text) -- the response body. So a 400, a 500, even a 200 with a
    // non-JSON body could force the service-key retry just by containing the
    // string " HTTP 401:" in its first 200 characters: the bound was "the
    // message happens to contain that substring", which is the remote end's
    // decision, not ours. A stated bound that does not hold is worse than a
    // known exposure, so it is now the status or nothing.
    const gatewayRejectedTheKey = Boolean(anonKey)
      && e instanceof SmokeSessionError
      && (e.status === 401 || e.status === 403);
    if (!gatewayRejectedTheKey) throw e;
    onNotice(
      'the publishable/anon key was rejected by the Supabase gateway (HTTP '
        + `${e.status}); retried /auth/v1/verify with the service-role key. The anon key is probably a `
        + 'disabled legacy JWT -- replace STAGING_SUPABASE_ANON_KEY with the modern publishable key.',
    );
    session = await redeem(serviceKey);
  }
  if (typeof session.access_token !== 'string' || !session.access_token) {
    throw boom(
      'verify',
      `response had no "access_token" (keys: ${keysOf(session)}); `
        + `token_hash from generate_link type=${verificationType} was not redeemable`,
    );
  }
  if (typeof session.refresh_token !== 'string' || !session.refresh_token) {
    throw boom('verify', 'response had an access_token but no "refresh_token"; the @supabase/ssr cookie would be unusable');
  }
  return session;
}
