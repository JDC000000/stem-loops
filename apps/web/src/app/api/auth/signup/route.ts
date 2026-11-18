// POST /api/auth/signup — hCaptcha-gated email+password signup (V3-C1).
//
// Body: { email, password, hcaptcha_token, return_to? }
// The bot challenge is verified server-side BEFORE Supabase signUp is called.
// Missing/invalid token -> 400 { code: 'BOT_CHALLENGE_FAILED' }.
//
// Success: { ok: true, needs_confirmation: boolean }. Errors carry
// { ok: false, code, error } — `error` is always this app's own one-line copy, never the
// provider's text — plus `sign_in: true` when the form should offer a Sign in link.

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServerClient } from '@/lib/auth/supabase';
import { validateSignupEmail, validatePassword } from '@/lib/auth/password-rules';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { verifyHcaptchaToken } from '@/lib/hcaptcha';
import { SIGNUP_GENERIC, signupErrorReply } from '@/lib/auth/signup-errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function clientIp(req: NextRequest): string | undefined {
  const xff = req.headers?.get?.('x-forwarded-for');
  return xff ? xff.split(',')[0].trim() || undefined : undefined;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  const token = typeof body?.hcaptcha_token === 'string' ? body.hcaptcha_token : '';
  if (!token) {
    return NextResponse.json(
      { ok: false, code: 'BOT_CHALLENGE_FAILED', error: 'Please complete the bot check.' },
      { status: 400, headers: NO_STORE },
    );
  }
  const verdict = await verifyHcaptchaToken(token, clientIp(request));
  if (!verdict.success) {
    return NextResponse.json(
      { ok: false, code: 'BOT_CHALLENGE_FAILED', error: 'Bot check failed. Please try again.' },
      { status: 400, headers: NO_STORE },
    );
  }

  // Sign-up only: also refuses local-part characters most providers bounce (Slice 1b).
  const emailError = validateSignupEmail(body?.email);
  // Authoritative password policy (same validator as password reset).
  const passwordError = validatePassword(body?.password);
  if (emailError || passwordError) {
    return NextResponse.json(
      { ok: false, code: 'SIGNUP_INVALID', error: emailError ?? passwordError },
      { status: 400, headers: NO_STORE },
    );
  }
  const email = String(body.email).trim();
  const dest = sanitizeReturnTo(
    typeof body.return_to === 'string' ? body.return_to : undefined,
    '/account',
  );
  // Through the server callback, not /login: /login only reacts to a successful
  // SIGNED_IN, so a failed PKCE exchange (link opened in a different browser than
  // the one that signed up) left a blank form. /auth/callback redirects failures
  // to /login?error=..., which renders LOGIN_ERROR_COPY. `type=signup` is what lets the
  // callback tell this link from a password-recovery one when the exchange fails.
  const emailRedirectTo = new URL(
    `/auth/callback?type=signup&next=${encodeURIComponent(dest)}`,
    request.nextUrl.origin,
  ).toString();

  try {
    const supabase = await createServerClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password: body.password,
      options: { emailRedirectTo },
    });
    if (error) {
      // Never the provider's text (Slice 1b): one plain line per case, lib/auth/signup-errors.ts.
      const reply = signupErrorReply(error);
      if (reply.unexpected) {
        // Code and status only: no address, no provider message.
        Sentry.captureMessage('signup: unmapped signUp error', {
          level: 'warning',
          tags: { route: 'api/auth/signup', auth_code: String((error as { code?: unknown }).code ?? ''), auth_status: String(error.status ?? '') },
        });
      }
      return NextResponse.json(
        { ok: false, code: reply.code, error: reply.error, sign_in: reply.sign_in },
        { status: reply.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { ok: true, needs_confirmation: !data?.session },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'api/auth/signup' } });
    return NextResponse.json(
      { ok: false, code: 'SIGNUP_FAILED', error: SIGNUP_GENERIC },
      { status: 500, headers: NO_STORE },
    );
  }
}
