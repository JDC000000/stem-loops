// /auth/callback — server-side PKCE exchange for Supabase Auth flows.
//
// Supabase sends the browser here after:
//   • Email confirmation link click (type=signup)
//   • Password reset link click       (type=recovery)
//   • OAuth provider return           (type=oauth)
//
// The link carries a one-time `?code=...` that the SERVER (not the browser)
// exchanges for a session using the service-free anon key plus the cookies on
// the request. On success we redirect the user to a sanitized `?next=` (or
// `/account` by default); on any failure we redirect to `/login` with a
// stable `error=auth_callback_failed` code the login page can render via the
// existing `ERROR_COPY` map.
//
// Hardening rules enforced here:
//   • `?next` is sanitized via `sanitizeReturnTo` (same whitelist used by
//     `/login`), which rejects external hosts, protocol-relative URLs,
//     control characters and anything that doesn't start with "/".
//   • Non-GET methods return 405 Method Not Allowed. The Supabase link is a
//     GET, and letting arbitrary methods through would expose the exchange
//     endpoint to CSRF-shaped probing.
//   • Auth exchange failures are reported to Sentry (same `captureException`
//     used elsewhere in the app). The user still gets the friendly redirect
//     — no stack traces leak.
//   • No code in the query → treat as a mis-handled link and redirect to
//     /login with the same error code. (Returning a 400 JSON would be
//     correct but unfriendly: the browser landed here, not the client.)
//
// Caching: forced dynamic. The response depends on the `?code=` single-use
// token; serving a cached redirect would at best burn a token and at worst
// hand a different user's exchange to the wrong browser.

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServerClient } from '@/lib/auth/supabase';
import { sanitizeReturnTo } from '@/lib/auth/return-to';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FAILED = '/login?error=auth_callback_failed';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const nextRaw = searchParams.get('next');
  const next = sanitizeReturnTo(nextRaw, '/account');

  if (!code) {
    // Reached without a code — a stale link, a copy-paste, or a bot. Send
    // them to login with the standard failure code rather than a blank 400,
    // so the user sees actionable copy instead of a browser error page.
    return NextResponse.redirect(new URL(FAILED, origin));
  }

  try {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      // Supabase returned an auth error (expired code, already-used code,
      // config drift). Report to Sentry — this is a security-relevant
      // signal when it spikes — but keep the user-facing path quiet.
      Sentry.captureException(error, { tags: { route: 'auth/callback' } });
      return NextResponse.redirect(new URL(FAILED, origin));
    }
  } catch (err) {
    // Unexpected throw (network to Supabase, missing env, programming
    // error). Same shape as above — capture and redirect.
    Sentry.captureException(err, { tags: { route: 'auth/callback' } });
    return NextResponse.redirect(new URL(FAILED, origin));
  }

  return NextResponse.redirect(new URL(next, origin));
}

// Any non-GET verb is a client bug or probe. 405 with Allow: GET per the
// HTTP spec so Supabase and curl see the correct method set.
const methodNotAllowed = () =>
  new NextResponse(null, { status: 405, headers: { Allow: 'GET' } });

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
