'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { createBrowserClient } from '@/lib/auth/supabase';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { PASSWORD_MIN_LENGTH, PASSWORD_RULE_TEXT, suggestEmailFix, validatePassword, validateSignupEmail } from '@/lib/auth/password-rules';
import { PasswordField } from '@/components/PasswordField';
import { appCopyError, authErrorMessage, loginErrorMessage } from '@/lib/auth/login-errors';
import { sendMagicLink } from '@/lib/auth/magic-link';
import { navigationGrace, trackEvent } from '@/lib/analytics';
import { fieldStyle, buttonBase, primaryButton, secondaryButton, secondaryEmphasisButton, textButton } from '@/lib/ui/form-styles';

type Mode = 'signin' | 'signup' | 'reset';
type BusyAction = Mode | 'magic' | 'google';

const input = fieldStyle;
const btn = buttonBase;
// White underlined text actions with a 44px tap target, never lime (brand book §7.10).
const linkBtn = textButton;
const LOGIN_FAILED = 'Sign-in did not complete. Please try again.';

export default function LoginForm({
  returnTo, initialError, initialMode = 'signin',
}: { returnTo?: string; initialError?: string; initialMode?: Mode }) {
  const dest = sanitizeReturnTo(returnTo, '/account');
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // F57 (copy audit v1.3.1): which action is in flight, not just "something is". Every
  // button stays disabled while any action runs, but only the pressed one changes its label,
  // so the label never names a different action than the one running.
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const busy = busyAction !== null;
  const [error, setError] = useState<string | null>(loginErrorMessage(initialError));
  const [notice, setNotice] = useState<string | null>(null);
  // Slice 1b: the sign-up route's "If you already have an account, sign in instead…" reply
  // carries `sign_in: true`; the error line then gets a Sign in link beside it.
  const [offerSignIn, setOfferSignIn] = useState(false);
  // QA A-09: the address last checked for a provider typo (on leaving the field, and on
  // submit). The hint shows only while the field still holds that address.
  const [typoChecked, setTypoChecked] = useState<string | null>(null);
  const typoFix = mode === 'signup' && typoChecked !== null && typoChecked === email ? suggestEmailFix(email) : null;
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

  // QA A-11: an error is about what was submitted; once the person edits a field it
  // describes, it goes, so it never sits beside a fresh browser validation bubble.
  function clearError() {
    setError(null);
    setOfferSignIn(false);
  }

  async function run(action: BusyAction, fn: () => Promise<string | null>) {
    setBusyAction(action);
    setError(null);
    setNotice(null);
    setOfferSignIn(false);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      // QA A-08: never e.message from fetch or supabase-js ("Failed to fetch"): one copy map.
      setError(authErrorMessage(e, action === 'signin' ? LOGIN_FAILED : undefined));
      setOfferSignIn(e instanceof Error && (e as Error & { signIn?: boolean }).signIn === true);
    } finally {
      setBusyAction(null);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Same rule the server enforces (/api/auth/signup), so the form never
    // accepts a password the server will reject. Sign-in is never checked:
    // existing accounts may predate these rules.
    if (mode === 'signup') {
      // A likely typo is pointed out, never blocked (QA A-09): the address as typed is sent.
      setTypoChecked(email);
      // Same check as the server: an address most providers will bounce is caught here,
      // before a confirmation email is sent to it (Slice 1b).
      const emailError = validateSignupEmail(email);
      if (emailError) { setError(emailError); return; }
      const pwError = validatePassword(password);
      if (pwError) { setError(pwError); return; }
    }
    void run(mode, async () => {
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
          ok?: boolean; error?: string; needs_confirmation?: boolean; sign_in?: boolean;
        };
        // Tokens are single-use: always demand a fresh challenge after an attempt.
        setCaptchaToken(null);
        captchaRef.current?.resetCaptcha();
        if (!res.ok || !json.ok) {
          // The route only ever sends its own one-line copy (lib/auth/signup-errors.ts).
          throw appCopyError(json.error ?? "We couldn't create your account just now — try again in a minute.", {
            signIn: json.sign_in === true,
          });
        }
        // 2A: the account exists now (confirmed or not). No props: nothing about who.
        trackEvent('signup', {});
        if (json.needs_confirmation) return 'Check your email to confirm your account.';
        // Signed straight in: give `signup` a bounded moment (≤150 ms) before the navigation.
        await navigationGrace();
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
    void run('magic', async () => {
      return sendMagicLink(createBrowserClient(), email, callbackUrl());
    });
  }

  function google() {
    void run('google', async () => {
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
            onChange={(e) => { setEmail(e.target.value); clearError(); }}
            onBlur={() => setTypoChecked(email)}
            aria-describedby={typoFix ? 'email-typo' : undefined}
            style={input} />
        </label>
        {typoFix && (
          <p id="email-typo" role="status" data-testid="email-typo"
            style={{ margin: '-4px 0 0', fontSize: 14, color: 'var(--text-secondary)' }}>
            Did you mean{' '}
            <button type="button" style={{ ...linkBtn, padding: '0 2px' }} data-testid="email-typo-fix"
              onClick={() => { setEmail(typoFix); setTypoChecked(typoFix); }}>
              {typoFix}
            </button>
            ?
          </p>
        )}
        {mode !== 'reset' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)', fontSize: 14 }}>
            <PasswordField label="Password" required
              minLength={mode === 'signup' ? PASSWORD_MIN_LENGTH : undefined}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              aria-describedby={mode === 'signup' ? 'password-rule' : undefined}
              value={password} onChange={(e) => { setPassword(e.target.value); clearError(); }} inputStyle={input} />
            {mode === 'signup' && (
              <span id="password-rule" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                {PASSWORD_RULE_TEXT}
              </span>
            )}
          </div>
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
          {busyAction === 'signup' ? 'Creating account…'
            : busyAction === 'reset' ? 'Sending reset link…'
              : busyAction === 'signin' ? 'Signing in…'
                : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>
      </form>

      {error && <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>{error}</p>}
      {error && offerSignIn && mode === 'signup' && (
        <button type="button" style={linkBtn} data-testid="signup-sign-in"
          onClick={() => { setError(null); setOfferSignIn(false); setMode('signin'); }}>
          Sign in
        </button>
      )}
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
          style={{ ...btn, ...secondaryEmphasisButton }}>
          New here? Create account
        </button>
      )}

      <hr style={{ border: 0, borderTop: '1px solid var(--border-subtle, #333)', width: '100%', margin: '4px 0' }} />

      <button type="button" onClick={magicLink} disabled={busy}
        style={{ ...btn, ...secondaryButton }}>
        {busyAction === 'magic' ? 'Sending link…' : 'Email me a one-time link'}
      </button>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
        The one-time link signs you in to an account you already have. It does not create one.
        {mode === 'signin' && ' New here? Use Create account.'}
      </p>
      <button type="button" onClick={google} disabled={busy}
        style={{ ...btn, ...secondaryButton }}>
        {busyAction === 'google' ? 'Opening Google…' : 'Continue with Google'}
      </button>
    </div>
  );
}
