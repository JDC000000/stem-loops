// POST /api/auth/reset-password-confirm — finalises the password reset.
//
// Body: { password: string }
// Preconditions: caller must have a valid Supabase recovery session cookie
// (set by `/auth/callback` after the user clicks the recovery email link).
// Without it `supabase.auth.updateUser` returns an auth error and we 401.
//
// Response:
//   • 200 { ok: true }                          — password updated
//   • 400 { ok: false, error_code: RESET_INVALID_PASSWORD, message }
//   • 401 { ok: false, error_code: UNAUTHENTICATED, message }
//   • 500 { ok: false, error_code: INTERNAL_ERROR, message }
//
// Caching: forced dynamic. Runtime: nodejs.

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServerClient, getUser } from '@/lib/auth/supabase';
import { validatePassword } from '@/lib/auth/password-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const passwordError = validatePassword(body?.password);
  if (passwordError) {
    return NextResponse.json(
      { ok: false, error_code: 'RESET_INVALID_PASSWORD', message: passwordError },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Trust boundary: require a verified session before we accept a new
  // password. `getUser()` round-trips to Supabase (vs `getSession()` which
  // just trusts the cookie), so a forged cookie can't reach updateUser.
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error_code: 'UNAUTHENTICATED', message: 'Open the reset link again to continue.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.updateUser({ password: String(body.password) });
    if (error) {
      // Supabase may reject the password for its own policy reasons
      // (reused recently, caught by HIBP, etc.). Surface a generic 400
      // — the client has already run our local checks and anything
      // further is Supabase's rule, not ours.
      Sentry.captureException(error, {
        tags: { route: 'api/auth/reset-password-confirm' },
      });
      return NextResponse.json(
        {
          ok: false,
          error_code: 'RESET_INVALID_PASSWORD',
          message: 'That password was rejected. Try a different one.',
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    // Revoke every OTHER session so a stolen session does not survive the
    // reset. Best-effort: the password is already changed, so a failure here
    // is reported but does not fail the request.
    const { error: revokeError } = await supabase.auth.signOut({ scope: 'others' });
    if (revokeError) {
      Sentry.captureException(revokeError, {
        tags: { route: 'api/auth/reset-password-confirm', step: 'revoke-other-sessions' },
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'api/auth/reset-password-confirm' },
    });
    return NextResponse.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: "Something went wrong on our end. We've logged it." },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
