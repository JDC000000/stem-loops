'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { createBrowserClient } from '@/lib/auth/supabase';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { PASSWORD_MIN_LENGTH, validatePassword } from '@/lib/auth/password-rules';
import { loginErrorMessage } from '@/lib/auth/login-errors';
import { sendMagicLink } from '@/lib/auth/magic-link';
import { fieldStyle, buttonBase, primaryButton, secondaryButton, textButton } from '@/lib/ui/form-styles';

type Mode = 'signin' | 'signup' | 'reset';

const input = fieldStyle;
const btn = buttonBase;
// White underlined text actions with a 44px tap target, never lime (brand book §7.10).
const linkBtn = textButton;

export default function LoginForm({
  returnTo, initialError, initialMode = 'signin',
}: { returnTo?: string; initialError?: string; initialMode?: Mode }) {
  const dest = sanitizeReturnTo(returnTo, '/account');
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(loginErrorMessage(initialError));
  const [notice, setNotice] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<HCaptcha>(null);
  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;

  // Password-reset emails go through the server callback so the user lands on
  // the set-password form (the SIGNED_IN handler below would send them to
  // /account instead).
  const recoveryUrl = () =>
    `${window.location.origin}/auth/callback?type=recovery&next=${encodeURIComponent('/account/reset-password')}`;

  // Email links and the Google redirect land back on /login with a `?code=`;
  // the browser client exchanges it on init and fires SIGNED_IN, handled below.
  // A server callback route DOES exist (app/auth/callback/route.ts; recoveryUrl()
  // above uses it). Magic-link and Google stay on this self-contained path on
  // purpose -- moving them is a separate change with its own testing.
  const callbackUrl = () =>
    `${window.location.origin}/login?return_to=${encodeURIComponent(dest)}`;

  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      const supabase = createBrowserClient();
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session) window.location.assign(dest);
      });
      unsub = () => data.subscription.unsubscribe();
    } catch {
      // Missing public env: sign-in attempts will surface the error inline.
    }
    return () => unsub?.();
  }, [dest]);

  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Same rule the server enforces (/api/auth/signup), so the form never
    // accepts a password the server will reject. Sign-in is never checked:
    // existing accounts may predate these rules.
    if (mode === 'signup') {
      const pwError = validatePassword(password);
      if (pwError) { setError(pwError); return; }
    }
    void run(async () => {
      const supabase = createBrowserClient();
      if (mode === 'reset') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: recoveryUrl() });
        if (err) throw err;
        return 'If that email has an account, a reset link is on its way.';
      }
      if (mode === 'signup') {
        // Signup goes through the server route so the hCaptcha token is
        // verified before Supabase signUp (V3-C1).
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, hcaptcha_token: captchaToken, return_to: dest }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean; error?: string; needs_confirmation?: boolean;
        };
        // Tokens are single-use: always demand a fresh challenge after an attempt.
        setCaptchaToken(null);
        captchaRef.current?.resetCaptcha();
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Could not create account. Please try again.');
        if (json.needs_confirmation) return 'Check your email to confirm your account.';
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
      window.location.assign(dest);
      return null;
    });
  }

  function magicLink() {
    if (!email) { setError('Enter your email first.'); return; }
    void run(async () => {
      return sendMagicLink(createBrowserClient(), email, callbackUrl());
    });
  }

  function google() {
    void run(async () => {
      const { error: err } = await createBrowserClient().auth.signInWithOAuth({
        provider: 'google', options: { redirectTo: callbackUrl() },
      });
      if (err) throw err;
      return null;
    });
  }

  const title = mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Sign in';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', margin: 0, color: 'var(--text-primary)' }}>{title}</h1>

      {/* /login cannot tell a new visitor from a returning one whose session lapsed: both are
          sent here from /jobs/[id] with the same return_to. So say both paths; never guess.
          Not when a ?error= is showing: that message already says what to do, and "if you are new,
          create an account" beside "your account was created" would invite a second signup. */}
      {mode === 'signin' && !initialError && dest.startsWith('/jobs/') && (
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary)' }}>
          Sign in to open your player. If you are new, create an account.
        </p>
      )}

      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)', fontSize: 14 }}>
          Email
          <input type="email" required autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} style={input} />
        </label>
        {mode !== 'reset' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)', fontSize: 14 }}>
            Password
            <input type="password" required
              minLength={mode === 'signup' ? PASSWORD_MIN_LENGTH : undefined}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} style={input} />
            {mode === 'signup' && (
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                At least {PASSWORD_MIN_LENGTH} characters, with a letter and a digit.
              </span>
            )}
          </label>
        )}
        {mode === 'signup' && (siteKey ? (
          <HCaptcha ref={captchaRef} sitekey={siteKey}
            onVerify={(t) => setCaptchaToken(t)}
            onExpire={() => setCaptchaToken(null)}
            onError={() => setCaptchaToken(null)} />
        ) : (
          <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>
            Sign-up is unavailable right now.
            Existing users can still sign in. Please try again later.
          </p>
        ))}
        {mode === 'signup' && siteKey && !captchaToken && (
          <p role="status" style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13 }}>
            Complete the bot check above to enable Create account. If it does not appear,
            disable ad or script blockers, check your connection, then reload the page.
          </p>
        )}
        <button type="submit" disabled={busy || (mode === 'signup' && !captchaToken)}
          style={{ ...btn, ...primaryButton }}>
          {busy ? 'Working…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>
      </form>

      {error && <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>{error}</p>}
      {notice && <p role="status" style={{ color: 'var(--status-done, #6c6)', margin: 0, fontSize: 14 }}>{notice}</p>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 8px', fontSize: 14, color: 'var(--text-muted)' }}>
        {mode === 'signin' && (
          <>
            <button type="button" style={linkBtn} onClick={() => setMode('reset')}>Forgot password?</button>
          </>
        )}
        {mode === 'signup' && (
          <button type="button" style={linkBtn} onClick={() => setMode('signin')}>Already have an account? Sign in</button>
        )}
        {mode === 'reset' && (
          <button type="button" style={linkBtn} onClick={() => setMode('signin')}>Back to sign in</button>
        )}
      </div>

      {mode === 'signin' && (
        <button type="button" onClick={() => setMode('signup')}
          style={{ ...btn, ...secondaryButton }}>
          New here? Create account
        </button>
      )}

      <hr style={{ border: 0, borderTop: '1px solid var(--border-subtle, #333)', width: '100%', margin: '4px 0' }} />

      <button type="button" onClick={magicLink} disabled={busy}
        style={{ ...btn, ...secondaryButton }}>
        Email me a one-time link
      </button>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
        The one-time link signs you in to an account you already have. It does not create one.
        {mode === 'signin' && ' New here? Use Create account.'}
      </p>
      <button type="button" onClick={google} disabled={busy}
        style={{ ...btn, ...secondaryButton }}>
        Continue with Google
      </button>
    </div>
  );
}
