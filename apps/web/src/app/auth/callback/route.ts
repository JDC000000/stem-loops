// /auth/callback -- server-side PKCE exchange for Supabase Auth flows.
//
// Supabase email links (password reset, signup confirmation) point here with
// a one-time `?code=...`. The SERVER exchanges it for a session using the
// cookies on the request (including the PKCE verifier set when the link was
// requested, which is why a link opened in a different browser fails).
//
// Outcomes:
//   • success                 -> redirect to the sanitized `?next=` (default /account)
//   • any failure             -> redirect to `/login?error=<code>`; the login page
//                                renders it via LOGIN_ERROR_COPY
//                                (lib/auth/login-errors.ts). Codes emitted:
//       auth_link_expired     Supabase redirected here with `error_code=otp_expired`
//       auth_signup_link_failed  a SIGNUP-confirmation link (`type=signup`, set by
//                             /api/auth/signup) whose `code` exchange was rejected
//                             or threw. The account exists, so "request a new link"
//                             is wrong for this user: the copy sends them to
//                             password sign-in (and Forgot password as the fallback)
//       auth_callback_failed  everything else: no `code`, or the exchange of a
//                             non-signup link (recovery) rejected or threw
//
// Every failure redirect also carries the sanitized `?next=` as `&return_to=` when
// one was supplied, so the destination (e.g. /jobs/<id>) survives the detour.
//
// NOT routed through here: magic-link and Google sign-in use
// `/login?code=...` and are exchanged by the browser client in LoginForm.
//
// Hardening:
//   • `?next` goes through `sanitizeReturnTo` (no external hosts, protocol-
//     relative URLs, control characters).
//   • Non-GET methods return 405 Allow: GET.
//   • Exchange failures and throws are reported to Sentry; the user only sees
//     the redirect.
//
// Caching: forced dynamic. The response depends on a single-use token.

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServerClient } from '@/lib/auth/supabase';
import { sanitizeReturnTo } from '@/lib/auth/return-to';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FAILED = '/login?error=auth_callback_failed';
const EXPIRED = '/login?error=auth_link_expired';
const SIGNUP_LINK_FAILED = '/login?error=auth_signup_link_failed';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const nextRaw = searchParams.get('next');
  const next = sanitizeReturnTo(nextRaw, '/account');
  const isSignup = searchParams.get('type') === 'signup';
  // Failure redirect that keeps the destination. Only when `next` was supplied, so a bare
  // callback URL still lands on the bare /login?error=... it always did.
  const fail = (base: string) =>
    NextResponse.redirect(
      new URL(nextRaw === null ? base : `${base}&return_to=${encodeURIComponent(next)}`, origin),
    );

  if (!code) {
    // No code: Supabase reporting an expired link (`error_code=otp_expired`),
    // or a stale link, copy-paste or bot. Redirect with a code the login page
    // has copy for, rather than a blank 400.
    if (searchParams.get('error_code') === 'otp_expired') {
      return fail(EXPIRED);
    }
    return fail(FAILED);
  }

  try {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      // Supabase returned an auth error (expired code, already-used code,
      // config drift). Report to Sentry — this is a security-relevant
      // signal when it spikes — but keep the user-facing path quiet.
      Sentry.captureException(error, { tags: { route: 'auth/callback' } });
      return fail(isSignup ? SIGNUP_LINK_FAILED : FAILED);
    }
  } catch (err) {
    // Unexpected throw (network to Supabase, missing env, programming
    // error). Same shape as above — capture and redirect.
    Sentry.captureException(err, { tags: { route: 'auth/callback' } });
    return fail(isSignup ? SIGNUP_LINK_FAILED : FAILED);
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
