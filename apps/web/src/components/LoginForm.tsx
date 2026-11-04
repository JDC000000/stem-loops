'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { createBrowserClient } from '@/lib/auth/supabase';
import { sanitizeReturnTo } from '@/lib/auth/return-to';

type Mode = 'signin' | 'signup' | 'reset';

const input = {
  width: '100%', minHeight: 44, padding: '0 12px', borderRadius: 8, fontSize: 16,
  border: '1px solid var(--border-default, #444)', background: 'var(--bg-surface, #151515)',
  color: 'var(--text-primary)', boxSizing: 'border-box' as const,
};
const btn = {
  width: '100%', minHeight: 44, padding: '0 16px', borderRadius: 8, fontWeight: 600, cursor: 'pointer',
  boxSizing: 'border-box' as const,
};
const linkBtn = {
  background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer',
  textDecoration: 'underline', font: 'inherit',
};

export default function LoginForm({ returnTo }: { returnTo?: string }) {
  const dest = sanitizeReturnTo(returnTo, '/account');
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Email links and the Google redirect land back on /login with a `?code=`;
  // the browser client exchanges it on init and fires SIGNED_IN, handled below.
  // (No server callback route exists yet; this keeps the flow self-contained.)
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
    void run(async () => {
      const supabase = createBrowserClient();
      if (mode === 'reset') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: callbackUrl() });
        if (err) throw err;
        return 'If that email has an account, a reset link is on its way.';
      }
      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({
          email, password, options: { emailRedirectTo: callbackUrl() },
        });
        if (err) throw err;
        if (!data.session) return 'Check your email to confirm your account.';
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
      const { error: err } = await createBrowserClient().auth.signInWithOtp({
        email, options: { emailRedirectTo: callbackUrl() },
      });
      if (err) throw err;
      return 'Check your email for a one-time login link.';
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
      <h1 style={{ fontSize: 26, margin: 0, color: 'var(--text-primary)' }}>{title}</h1>

      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)', fontSize: 14 }}>
          Email
          <input type="email" required autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} style={input} />
        </label>
        {mode !== 'reset' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)', fontSize: 14 }}>
            Password
            <input type="password" required minLength={8}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} style={input} />
          </label>
        )}
        <button type="submit" disabled={busy}
          style={{ ...btn, border: 'none', background: 'var(--btn-primary-bg, var(--accent))', color: 'var(--btn-primary-text, #000)' }}>
          {busy ? 'Working…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>
      </form>

      {error && <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>{error}</p>}
      {notice && <p role="status" style={{ color: 'var(--status-done, #6c6)', margin: 0, fontSize: 14 }}>{notice}</p>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 14, color: 'var(--text-muted)' }}>
        {mode === 'signin' && (
          <>
            <button type="button" style={linkBtn} onClick={() => setMode('signup')}>Create account</button>
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

      <hr style={{ border: 0, borderTop: '1px solid var(--border-subtle, #333)', width: '100%', margin: '4px 0' }} />

      <button type="button" onClick={magicLink} disabled={busy}
        style={{ ...btn, border: '1px solid var(--border-default, #444)', background: 'transparent', color: 'var(--text-primary)' }}>
        Send me a one-time login link
      </button>
      <button type="button" onClick={google} disabled={busy}
        style={{ ...btn, border: '1px solid var(--border-default, #444)', background: 'transparent', color: 'var(--text-primary)' }}>
        Continue with Google
      </button>
    </div>
  );
}
