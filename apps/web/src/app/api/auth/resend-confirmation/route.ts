// POST /api/auth/resend-confirmation — send the sign-up confirmation email again (QW-7).
//
// Body: { email, hcaptcha_token, return_to? }
//
// A password sign-in on an unconfirmed account used to be a dead end: "Confirm your email
// first" and no way to get a new link. LoginForm now offers "Resend confirmation email" on that
// error, and it comes here.
//
// Posture (same as /api/auth/signup, plus the CSRF guard and a limiter):
//   1. same-origin guard (lib/same-origin.ts) -> 403 BAD_ORIGIN;
//   2. per-IP limit (lib/auth/resend-limit.ts) -> 429 RATE_LIMITED + Retry-After;
//   3. hCaptcha verified server-side BEFORE Supabase is called -> 400 BOT_CHALLENGE_FAILED;
//   4. email shape -> 400 RESEND_INVALID_EMAIL (structural only, like reset-password-request);
//   5. per-address limit: inside its window nothing is sent, and the reply is the normal 200;
//   6. supabase.auth.resend({ type: 'signup' }) with the link pointed at /auth/callback?type=signup
//      (the same target /api/auth/signup uses, so a failed exchange gets the sign-up copy).
//
// NO ACCOUNT ENUMERATION. From step 5 on, the reply is always 200 { ok: true }: unknown address,
// address already confirmed, Supabase rate limit or error, Supabase throwing, the per-address
// window. Supabase errors go to Sentry with code and status only, never the address.
//
// Caching: forced dynamic, no-store. Runtime: nodejs (Supabase SSR cookie adapter, which also
// stores the PKCE verifier for the new link in THIS browser's cookies).

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServerClient } from '@/lib/auth/supabase';
import { validateEmail } from '@/lib/auth/password-rules';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { verifyHcaptchaToken } from '@/lib/hcaptcha';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { clientIp } from '@/lib/client-ip';
import { admitResendEmail, admitResendIp, resendIpRetryAfterSec } from '@/lib/auth/resend-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Supabase error code, only when it is a plain token (never free text into Sentry tags). */
function safeCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : '';
}

export async function POST(request: NextRequest) {
  const originRefusal = crossOriginRefusal(request);
  if (originRefusal) {
    return NextResponse.json(
      { ok: false, error_code: BAD_ORIGIN, message: originRefusal },
      { status: 403, headers: NO_STORE },
    );
  }

  const ip = clientIp(request);
  if (!admitResendIp(ip)) {
    return NextResponse.json(
      { ok: false, error_code: 'RATE_LIMITED', message: 'Too many tries. Wait a few minutes and try again.' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(resendIpRetryAfterSec(ip)) } },
    );
  }

  const body = await request.json().catch(() => null);

  const token = typeof body?.hcaptcha_token === 'string' ? body.hcaptcha_token : '';
  if (!token) {
    return NextResponse.json(
      { ok: false, error_code: 'BOT_CHALLENGE_FAILED', message: 'Please complete the bot check.' },
      { status: 400, headers: NO_STORE },
    );
  }
  const verdict = await verifyHcaptchaToken(token, ip === '0.0.0.0' ? undefined : ip);
  if (!verdict.success) {
    return NextResponse.json(
      { ok: false, error_code: 'BOT_CHALLENGE_FAILED', message: 'Bot check failed. Please try again.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const emailError = validateEmail(body?.email);
  if (emailError) {
    // Structural only (empty, no @, too long): says nothing about whether an account exists.
    return NextResponse.json(
      { ok: false, error_code: 'RESEND_INVALID_EMAIL', message: emailError },
      { status: 400, headers: NO_STORE },
    );
  }
  const email = String(body.email).trim();

  if (admitResendEmail(email)) {
    const dest = sanitizeReturnTo(
      typeof body.return_to === 'string' ? body.return_to : undefined,
      '/account',
    );
    const emailRedirectTo = new URL(
      `/auth/callback?type=signup&next=${encodeURIComponent(dest)}`,
      request.nextUrl.origin,
    ).toString();
    try {
      const supabase = await createServerClient();
      const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo } });
      if (error) {
        Sentry.captureMessage('resend-confirmation: auth error', {
          level: 'warning',
          tags: {
            route: 'api/auth/resend-confirmation',
            auth_code: safeCode((error as { code?: unknown }).code),
            auth_status: typeof error.status === 'number' ? String(error.status) : '',
          },
        });
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { route: 'api/auth/resend-confirmation' } });
    }
  }

  return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}
