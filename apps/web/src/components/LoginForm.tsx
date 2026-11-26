'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { createBrowserClient } from '@/lib/auth/supabase';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { PASSWORD_MIN_LENGTH, PASSWORD_RULE_TEXT, suggestEmailFix, validatePassword, validateSignupEmail } from '@/lib/auth/password-rules';
import { PasswordField } from '@/components/PasswordField';
import {
  appCopyError, authErrorMessage, isEmailNotConfirmed, loginErrorMessage,
  LINK_FAILED_CODES, LINK_FAILED_LINK_KEPT, LINK_FAILED_REPASTE,
  RESEND_CAPTCHA_HINT, RESEND_CONFIRMATION_FAILED, RESEND_CONFIRMATION_LABEL, RESEND_CONFIRMATION_SENT,
} from '@/lib/auth/login-errors';
import { forgetEmail, recallEmail, rememberEmail } from '@/lib/auth/remembered-email';
import { sendMagicLink } from '@/lib/auth/magic-link';
import { navigationGrace, trackEvent } from '@/lib/analytics';
import { fieldStyle, buttonBase, primaryButton, secondaryButton, secondaryEmphasisButton, textButton } from '@/lib/ui/form-styles';
import { clearPendingLink, hasPendingLink, isPendingReturnTo, resumeNonce } from '@/lib/pending-link';

type Mode = 'signin' | 'signup' | 'reset';
type BusyAction = Mode | 'magic' | 'google' | 'resend';

const input = fieldStyle;
const btn = buttonBase;
// White underlined text actions with a 44px tap target, never lime (brand book §7.10).
const linkBtn = textButton;
const LOGIN_FAILED = 'Sign-in did not complete. Please try again.';

const safeStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export default function LoginForm({
  returnTo, initialError, initialMode = 'signin',
}: { returnTo?: string; initialError?: string; initialMode?: Mode }) {
  const rawDest = sanitizeReturnTo(returnTo, '/account');
  const [mode, setMode] = useState<Mode>(initialMode);
  // A4 (2026-11-21): Google is the first and largest option; every email path (password, sign-up,
  // reset, one-time link) is folded under "Use email instead". It starts OPEN when the visitor is
  // already on an email path: sign-up or reset mode, or an error that is about email/password.
  const [emailOpen, setEmailOpen] = useState<boolean>(initialMode !== 'signin' || !!initialError);
  // Sent here by the home form with a link waiting to start (lib/pending-link.ts). "Not your
  // song?" drops it (and the marker), so whoever signs in here does not start someone else's song.
  const [dropped, setDropped] = useState(false);
  const dest = dropped && isPendingReturnTo(rawDest) ? '/' : rawDest;
  const linkWaiting = isPendingReturnTo(dest);
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
  // QW-7: a password sign-in refused as "email not confirmed" offers a resend, behind its own
  // hCaptcha (the route verifies it, like sign-up).
  const [offerResend, setOfferResend] = useState(false);
  const [resendToken, setResendToken] = useState<string | null>(null);
  const resendCaptchaRef = useRef<HCaptcha>(null);
  // QW-6: an email link that could not finish in this browser (LINK_FAILED_CODES). Set from the
  // callback's ?error= or by the mount check below for a /login?code= that produced no session.
  const [linkFailed, setLinkFailed] = useState<boolean>(!!initialError && LINK_FAILED_CODES.has(initialError));
  // What happened to a waiting song link, once a link failed: still saved here, or in the other browser.
  const [linkNote, setLinkNote] = useState<string | null>(null);
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
        // A sign-in that is NOT the pending-link round trip, and any sign-out, drops a saved link
        // (lib/pending-link.ts): another person signing in on this device never inherits it.
        if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && !isPendingReturnTo(dest))) clearPendingLink(safeStorage());
        if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') forgetEmail(safeStorage());
        if (event === 'SIGNED_IN' && session) window.location.assign(dest);
      });
      unsub = () => data.subscription.unsubscribe();
    } catch {
      // Missing public env: sign-in attempts will surface the error inline.
    }
    return () => unsub?.();
  }, [dest]);

  // QW-6: a one-time link or the Google return lands here as /login?code=...; the browser client
  // exchanges it while it initialises. When that produces no session (no PKCE verifier in this
  // browser: the link was requested in another one), nothing fired and the visitor saw a blank
  // form. Now: wait for initialisation, and with no session say what happened, open the email
  // options and drop the dead code from the address bar (return_to stays).
  useEffect(() => {
    let cancelled = false;
    let hadCode = false;
    try {
      hadCode = new URLSearchParams(window.location.search).has('code');
    } catch {
      hadCode = false;
    }
    if (!hadCode) return;
    void (async () => {
      let session: unknown = null;
      try {
        const { data } = await createBrowserClient().auth.getSession();
        session = data?.session ?? null;
      } catch {
        session = null;
      }
      if (cancelled || session) return;
      setError(loginErrorMessage('auth_signin_link_failed'));
      setLinkFailed(true);
      setEmailOpen(true);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        window.history.replaceState(window.history.state, '', url.toString());
      } catch {
        /* the copy is shown either way */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // QW-6: once a link has failed, put back the address typed here when the link was asked for
  // (same browser only; lib/auth/remembered-email.ts) and say whether a waiting song survives.
  useEffect(() => {
    if (!linkFailed) return;
    const remembered = recallEmail(safeStorage());
    if (remembered) setEmail((cur) => cur || remembered);
    if (isPendingReturnTo(dest)) {
      setLinkNote(hasPendingLink(safeStorage(), resumeNonce(dest.slice(1))) ? LINK_FAILED_LINK_KEPT : LINK_FAILED_REPASTE);
    } else {
      setLinkNote(null);
    }
  }, [linkFailed, dest]);

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
    setLinkFailed(false);
    setLinkNote(null);
    if (action !== 'resend') setOfferResend(false);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      // QA A-08: never e.message from fetch or supabase-js ("Failed to fetch"): one copy map.
      setError(authErrorMessage(e, action === 'signin' ? LOGIN_FAILED : action === 'resend' ? RESEND_CONFIRMATION_FAILED : undefined));
      setOfferSignIn(e instanceof Error && (e as Error & { signIn?: boolean }).signIn === true);
      if (action === 'signin' && isEmailNotConfirmed(e)) setOfferResend(true);
    } finally {
      setBusyAction(null);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Same rule the server enforces (/api/auth/signup), so the form never
    // accepts a password the server will reject. Sign-in is never checked:
    // existing accounts may predate these rules.
    rememberEmail(safeStorage(), email);
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
    rememberEmail(safeStorage(), email);
    void run('magic', async () => {
      return sendMagicLink(createBrowserClient(), email, callbackUrl());
    });
  }

  // QW-7: send the confirmation email again. Same reply whether or not the address has an
  // account waiting (the route never says), so the notice is the same line every time.
  function resendConfirmation() {
    if (!email) { setError('Enter your email first.'); return; }
    void run('resend', async () => {
      const res = await fetch('/api/auth/resend-confirmation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, hcaptcha_token: resendToken, return_to: dest }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      // Tokens are single-use: always demand a fresh challenge after an attempt.
      setResendToken(null);
      resendCaptchaRef.current?.resetCaptcha();
      if (!res.ok || !json.ok) throw appCopyError(json.message || RESEND_CONFIRMATION_FAILED);
      setOfferResend(false);
      return RESEND_CONFIRMATION_SENT;
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

  // Errors and notices sit under the action that caused them: inside the email options when they
  // are open, under the Google button when they are folded (a Google error must never be hidden).
  const messages = (
    <>
      {error && <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>{error}</p>}
      {error && offerSignIn && mode === 'signup' && (
        <button type="button" style={linkBtn} data-testid="signup-sign-in"
          onClick={() => { setError(null); setOfferSignIn(false); setMode('signin'); }}>
          Sign in
        </button>
      )}
      {error && linkNote && (
        <p data-testid="login-link-note" style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary)' }}>{linkNote}</p>
      )}
      {offerResend && mode === 'signin' && (
        <div data-testid="login-resend" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {siteKey && (
            <HCaptcha ref={resendCaptchaRef} sitekey={siteKey}
              onVerify={(t) => setResendToken(t)}
              onExpire={() => setResendToken(null)}
              onError={() => setResendToken(null)} />
          )}
          {siteKey && !resendToken && (
            <p role="status" style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13 }}>{RESEND_CAPTCHA_HINT}</p>
          )}
          <button type="button" onClick={resendConfirmation} disabled={busy || !siteKey || !resendToken}
            data-testid="login-resend-button" style={{ ...btn, ...secondaryButton }}>
            {busyAction === 'resend' ? 'Sending…' : RESEND_CONFIRMATION_LABEL}
          </button>
        </div>
      )}
      {notice && <p role="status" style={{ color: 'var(--status-done, #6c6)', margin: 0, fontSize: 14 }}>{notice}</p>}
    </>
  );

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
      {!initialError && linkWaiting && (
        <div data-testid="login-link-waiting" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* True to app/api/jobs/route.ts: every signed-in link job is metered against the
              account's monthly songs (bumpJobsUsed / bumpJobsUsedWithinQuota; a trial song too,
              while one is left), and credits never pay for a link. */}
          <p style={{ margin: 0, fontSize: 16, color: 'var(--text-secondary)' }}>
            Sign in and your song starts straight away. It uses 1 of your monthly songs. New here? Google creates your free
            account in one step.
          </p>
          <button type="button" style={{ ...linkBtn, alignSelf: 'flex-start' }} data-testid="login-link-drop"
            onClick={() => { clearPendingLink(safeStorage()); setDropped(true); }}>
            Not your song? Sign in without it
          </button>
        </div>
      )}

      {/* Google first and largest. It is the one lime action on the view while the email options
          are folded; once they are open the email form's own button takes the lime, and Google
          steps down to a plain secondary (still first and largest), so there is still exactly one
          lime action, and "New here? Create account" stays the one emphasised secondary. */}
      <button type="button" onClick={google} disabled={busy} data-testid="login-google"
        style={{ ...btn, ...(emailOpen ? secondaryButton : primaryButton), minHeight: 56, fontSize: 17 }}>
        {busyAction === 'google' ? 'Opening Google…' : 'Continue with Google'}
      </button>
      {!emailOpen && messages}

      <button type="button" style={{ ...linkBtn, alignSelf: 'flex-start' }} data-testid="login-email-toggle"
        aria-expanded={emailOpen} aria-controls="login-email"
        onClick={() => setEmailOpen((o) => !o)}>
        {emailOpen ? 'Hide email options' : 'Use email instead'}
      </button>

      <div id="login-email" hidden={!emailOpen} style={{ display: emailOpen ? 'flex' : undefined, flexDirection: 'column', gap: 14 }}>
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
        {/* Lime only while the email options are open (they are hidden otherwise), so the view
            always has exactly one lime action: this, or Google above. */}
        <button type="submit" disabled={busy || (mode === 'signup' && !captchaToken)}
          style={{ ...btn, ...(emailOpen ? primaryButton : secondaryButton) }}>
          {busyAction === 'signup' ? 'Creating account…'
            : busyAction === 'reset' ? 'Sending reset link…'
              : busyAction === 'signin' ? 'Signing in…'
                : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>
      </form>

      {emailOpen && messages}

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
      </div>
    </div>
  );
}
