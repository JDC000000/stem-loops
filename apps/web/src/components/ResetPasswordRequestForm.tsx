'use client';

// "I forgot my password" — unauthenticated-ok form that fires
// POST /api/auth/reset-password-request. Success is shown as a neutral
// "check your email" message regardless of whether the address is
// registered (anti-enumeration — matches the server policy).

import { useState, type FormEvent } from 'react';
import { validateEmail } from '@/lib/auth/password-rules';

const input = {
  width: '100%',
  minHeight: 44,
  padding: '0 12px',
  borderRadius: 8,
  fontSize: 16,
  border: '1px solid var(--border-default, #444)',
  background: 'var(--bg-surface, #151515)',
  color: 'var(--text-primary)',
  boxSizing: 'border-box' as const,
};
const btn = {
  width: '100%',
  minHeight: 44,
  padding: '0 16px',
  borderRadius: 8,
  fontWeight: 600,
  cursor: 'pointer',
  border: 'none',
  background: 'var(--btn-primary-bg, var(--accent))',
  color: 'var(--btn-primary-text, #000)',
  boxSizing: 'border-box' as const,
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
        <h1 style={{ fontSize: 26, margin: 0, color: 'var(--text-primary)' }}>Check your email</h1>
        <p role="status" style={{ color: 'var(--text-secondary)', margin: 0 }}>
          If an account exists for <strong>{email}</strong>, a reset link is on its way.
          Open the link on this device to continue.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>
          Can&apos;t find the email? Check your spam folder.
        </p>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1 style={{ fontSize: 26, margin: 0, color: 'var(--text-primary)' }}>Reset password</h1>
      <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 14 }}>
        Enter your email and we&apos;ll send you a link to set a new password.
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
        <a href="/login">Back to sign in</a>
      </p>
    </div>
  );
}
