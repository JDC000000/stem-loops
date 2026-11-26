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
// THE COOKIE IS CLEARED EVEN IF SUPABASE IS DOWN. supabase-js keeps the session when the revoke
// call fails with anything but a 401/403/404, so this route also expires every Supabase auth
// cookie it can see (`sb-<ref>-auth-token`, its `.0`/`.1` chunks and the PKCE code verifier).
// The refresh token may then live on server-side until it expires; the browser no longer holds it.
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

export async function POST(request: NextRequest) {
  const originRefusal = crossOriginRefusal(request);
  if (originRefusal) {
    return NextResponse.json(
      { ok: false, error_code: BAD_ORIGIN, message: originRefusal },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) Sentry.captureException(error, { tags: { route: 'api/auth/signout' } });
  } catch (err) {
    // Supabase unreachable or env missing: still clear the cookies below.
    Sentry.captureException(err, { tags: { route: 'api/auth/signout' } });
  }

  const jar = cookies();
  for (const { name } of jar.getAll()) {
    if (AUTH_COOKIE_RE.test(name)) jar.delete(name);
  }

  // Relative Location (RFC 9110 §10.2.2): never built from the Host header, so a proxy's
  // internal host name cannot leak into the redirect.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: '/', 'Cache-Control': 'no-store' },
  });
}
