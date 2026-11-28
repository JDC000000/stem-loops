// POST /api/auth/signout — ends THIS browser's session and goes home (beta QA S5).
//
// Called by a plain HTML form (components/AccountActions.tsx), so it works without JavaScript:
// the browser follows the 303 to `/` with a GET. JSON callers get the same 303.
//
// Response:
//   • 303 Location: /                                — signed out (or already signed out)
//   • 403 { ok: false, error_code: BAD_ORIGIN, … }   — cross-origin / no Origin (CSRF)
//   GET and every other method: 405 (Next answers for methods a route does not export).
//
// CSRF: same-origin browser requests only (src/lib/same-origin.ts), like every other mutating
// route. A foreign page must not be able to sign a user out (a forced sign-out is a nuisance, and
// the first step of a login-CSRF swap).
//
// SCOPE 'local': only this browser's session ends. A tester signed in on a second device stays
// signed in there (G1's "second device"); "sign out everywhere" is not in the beta.
//
// THE COOKIES ARE CLEARED EVEN IF SUPABASE IS DOWN. This route expires every Supabase auth
// cookie it can see (`sb-<ref>-auth-token`, its `.0`/`.1` chunks and the PKCE code verifier)
// whatever the revoke call did.
//
// THE REVOKE IS RETRIED (#485). Clearing the cookie only takes the refresh token out of this
// browser; until POST /logout succeeds the session stays valid server-side. supabase-js 2.117
// drops its local session even when /logout fails, so calling auth.signOut() again would find no
// token and return success without revoking anything. Instead the access token is read once,
// before the first attempt, and a network or 5xx failure (AuthRetryableFetchError, or a throw) is
// retried by posting that token to /logout directly: auth.admin.signOut(jwt, 'local') is the
// user-JWT logout call, sent with the public anon key, NOT the service-role key. Two retries,
// 150 ms then 450 ms apart, so a sign-out waits at most ~0.6 s more than the calls themselves.
// A 401/403/404 means the session is already gone (supabase-js treats it the same way). Any other
// answer is not retried. A failure that outlasts the retries is reported once to Sentry, tagged
// `revoke: failed`; the token itself is never logged. The token is used only to revoke itself;
// no access decision rests on getSession() here.
//
// EVERY CALL IS BOUNDED (#514). The client is built with a fetch that aborts any request still
// open after 2 s (REVOKE_TIMEOUT_MS), so a black-holed Supabase cannot hold sign-out. supabase-js
// 2.117.3 takes no signal on signOut()/admin.signOut(), but sends every auth request through the
// client's global.fetch and turns a rejected fetch (an abort included) into
// AuthRetryableFetchError: a timeout is retried like any network failure, inside the same two
// retries. Worst case ~6.6 s (three 2 s calls and the backoff); then the cookies are cleared and
// the 303 returned as usual. The wrapper adds only the signal: it never reads, logs or alters the
// request, so the token goes nowhere but its own /logout call.
//
// SL-HISTORY IS CLEARED TOO (#486). The signed `sl-history` cookie mirrors this browser's
// anonymous song history and is never scoped to a user (components/chrome/SignedInChrome.tsx).
// On a shared machine, the next person to use the browser would otherwise inherit the last
// user's job ids. Signing out is the "I am leaving this browser" action, so it goes with the
// session; the songs of a signed-in user stay in their server-side library. The localStorage
// copy is cleared on submit by components/AccountActions.tsx (it is not reachable from here).
//
// Caching: forced dynamic. Runtime: nodejs.

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import * as Sentry from '@sentry/nextjs';
import { createServerClient } from '@/lib/auth/supabase';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A Supabase auth cookie: the session (plain or chunked) or the PKCE code verifier. Not
 *  exported: a route module may export only Next's route fields. */
const AUTH_COOKIE_RE = /^sb-[^=;\s]+-auth-token(?:\.\d+|-code-verifier)?$/;

/** The anonymous history mirror (api/history/set-cookie). Cleared on sign-out (#486). */
const HISTORY_COOKIE = 'sl-history';

/** Wait before each retry of a failed revoke (#485). Its length is the number of retries. */
const REVOKE_RETRY_DELAYS_MS = [150, 450] as const;

/** The longest any one Supabase request from this route may stay open (#514). */
const REVOKE_TIMEOUT_MS = 2000;

/** fetch, aborted after REVOKE_TIMEOUT_MS (a TimeoutError). auth-js 2.117.3 passes no signal of
 *  its own, so this one is the only one. The timer runs on setTimeout and is cleared once the
 *  response arrives (logout reads no body). */
function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('sign-out request timed out', 'TimeoutError')),
    REVOKE_TIMEOUT_MS,
  );
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

type RevokeResult = { error: unknown };

/** The error a revoke call ended with, or null when it worked. A throw counts as an error. */
async function attempt(call: () => Promise<RevokeResult>): Promise<unknown> {
  try {
    const { error } = await call();
    return error ?? null;
  } catch (err) {
    return err ?? new Error('sign-out threw');
  }
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Worth retrying: a network or 5xx failure (supabase-js names it AuthRetryableFetchError), or
 *  anything that is not an auth error with an HTTP status (e.g. a thrown TypeError). */
function isRetryable(err: unknown): boolean {
  if ((err as { name?: unknown } | null)?.name === 'AuthRetryableFetchError') return true;
  return statusOf(err) === undefined;
}

/** The server no longer knows this session: nothing left to revoke. */
function isGone(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403 || status === 404;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function POST(request: NextRequest) {
  const originRefusal = crossOriginRefusal(request);
  if (originRefusal) {
    return NextResponse.json(
      { ok: false, error_code: BAD_ORIGIN, message: originRefusal },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let failure: unknown = null;
  try {
    const supabase = await createServerClient({ fetch: boundedFetch });
    let token: string | undefined;
    try {
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token ?? undefined;
    } catch {
      // No token to retry with; the first signOut below still runs.
    }
    failure = await attempt(() => supabase.auth.signOut({ scope: 'local' }));
    for (const delay of REVOKE_RETRY_DELAYS_MS) {
      if (failure === null || !token || !isRetryable(failure)) break;
      await sleep(delay);
      const jwt = token;
      failure = await attempt(() => supabase.auth.admin.signOut(jwt, 'local'));
      if (failure !== null && isGone(failure)) failure = null;
    }
  } catch (err) {
    // Supabase env missing: nothing could be revoked. Still clear the cookies below.
    failure = err;
  }
  if (failure !== null) {
    Sentry.captureException(failure, { tags: { route: 'api/auth/signout', revoke: 'failed' } });
  }

  const jar = cookies();
  for (const { name } of jar.getAll()) {
    if (AUTH_COOKIE_RE.test(name) || name === HISTORY_COOKIE) jar.delete(name);
  }

  // Relative Location (RFC 9110 §10.2.2): never built from the Host header, so a proxy's
  // internal host name cannot leak into the redirect.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: '/', 'Cache-Control': 'no-store' },
  });
}
