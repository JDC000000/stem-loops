// POST /api/auth/reset-password-request — kicks off the password reset flow.
//
// Body: { email: string }
// Response: always `{ ok: true }` on anything that looks valid, so an
// attacker can't use this endpoint to enumerate registered addresses.
// Shape-invalid input gets a 400 with a generic code — that's not an
// enumeration oracle (it fires on obvious typos / empty body).
//
// Server-side, we call `supabase.auth.resetPasswordForEmail(email, { redirectTo })`
// where redirectTo points at `/auth/callback?type=recovery&next=/account/reset-password`.
// After the user clicks the email link, Supabase sends them to that callback
// which exchanges the code for a session cookie and forwards them to the
// set-new-password view of the reset-password page.
//
// Caching: forced dynamic. Runtime: nodejs (Supabase SSR cookie adapter).

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServerClient } from '@/lib/auth/supabase';
import { validateEmail } from '@/lib/auth/password-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Build the redirectTo URL from the *request* origin. Honours whatever host
// the browser used (prod domain, Vercel preview, localhost) without a
// NEXT_PUBLIC_SITE_URL env coupling. The callback route then forwards to the
// reset-password page's set-new state.
function buildRedirectTo(request: NextRequest): string {
  const url = new URL(
    '/auth/callback?type=recovery&next=/account/reset-password',
    request.nextUrl.origin,
  );
  return url.toString();
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const emailError = validateEmail(body?.email);
  if (emailError) {
    // 400 for shape-invalid inputs (empty body, missing field, obvious
    // typo). Does not reveal account existence — the error is purely
    // structural.
    return NextResponse.json(
      { ok: false, error_code: 'RESET_INVALID_EMAIL', message: emailError },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const email = String(body.email).trim();

  try {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: buildRedirectTo(request),
    });
    if (error) {
      // Supabase can return rate-limit / config errors here. Report to
      // Sentry (so a spike is visible) but STILL return ok:true to the
      // client — surfacing "unknown email" or "rate limited for this
      // address" would leak signal to an enumeration attack.
      Sentry.captureException(error, {
        tags: { route: 'api/auth/reset-password-request' },
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'api/auth/reset-password-request' },
    });
    // Same policy — no leak. The user will see the "check your email"
    // success state; if Supabase truly couldn't send the mail, they can
    // try again in a minute (which will also be rate-limited silently).
  }

  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
