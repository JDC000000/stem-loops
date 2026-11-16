'use client';

// "I forgot my password" — unauthenticated-ok form that fires
// POST /api/auth/reset-password-request. Success is shown as a neutral
// "check your email" message regardless of whether the address is
// registered (anti-enumeration — matches the server policy).

import { useState, type FormEvent } from 'react';
import { fieldStyle, buttonBase, primaryButton } from '@/lib/ui/form-styles';
import { validateEmail } from '@/lib/auth/password-rules';

const input = fieldStyle;
const btn = { ...buttonBase, ...primaryButton };

// Text links need a 44px tap target; inline-flex centres the label.
const linkStyle = {
  display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 8px', marginLeft: -8,
};

export default function ResetPasswordRequestForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const err = validateEmail(email);
    if (err) {
      setError(err);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reset-password-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        // The server returns a generic validator error for shape-invalid
        // inputs — surface its message. Any other status gets a neutral
        // fallback (no raw server errors per error-copy.ts convention).
        const body = await res.json().catch(() => ({}));
        setError(
          typeof body?.message === 'string'
            ? body.message
            : "We couldn't send a reset link. Please try again.",
        );
        return;
      }
      setSent(true);
    } catch {
      setError("We couldn't send a reset link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 style={{ fontSize: 'var(--text-2xl)', margin: 0, color: 'var(--text-primary)' }}>Check your email</h1>
        <p role="status" style={{ color: 'var(--text-secondary)', margin: 0 }}>
          If an account exists for <strong>{email}</strong>, a reset link is on its way.
          Open the link in this browser to continue.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>
          Can&apos;t find the email? Check your spam folder.
        </p>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>
          <a href="/login" style={linkStyle}>Back to sign in</a>
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', margin: 0, color: 'var(--text-primary)' }}>Reset password</h1>
      <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 14 }}>
        Enter your email and we’ll send you a link to set a new password.
      </p>

      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: 'var(--text-secondary)',
            fontSize: 14,
          }}
        >
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={input}
          />
        </label>
        <button type="submit" disabled={busy} style={btn}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      {error && (
        <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>
          {error}
        </p>
      )}

      <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>
        <a href="/login" style={linkStyle}>Back to sign in</a>
      </p>
    </div>
  );
}
