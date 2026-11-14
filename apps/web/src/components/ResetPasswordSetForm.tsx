'use client';

// "Set a new password" — rendered when the viewer already has a Supabase
// recovery session (they clicked the email link and the callback route
// gave them the session cookie). Submits to
// POST /api/auth/reset-password-confirm which calls supabase.auth.updateUser.

import { useState, type FormEvent } from 'react';
import { fieldStyle, buttonBase, primaryButton } from '@/lib/ui/form-styles';
import {
  validatePassword,
  PASSWORD_MIN_LENGTH,
} from '@/lib/auth/password-rules';

const input = fieldStyle;
const btn = { ...buttonBase, ...primaryButton };

export default function ResetPasswordSetForm() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const err = validatePassword(password);
    if (err) {
      setError(err);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/reset-password-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          typeof body?.message === 'string'
            ? body.message
            : "We couldn't update your password. Please try again.",
        );
        return;
      }
      setDone(true);
      // Redirect to /account where the user lands on the normal signed-in
      // view with a ?reset=success so the page can render a toast.
      window.location.assign('/account?reset=success');
    } catch {
      setError("We couldn't update your password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', margin: 0, color: 'var(--text-primary)' }}>Set a new password</h1>
      <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 14 }}>
        Choose a password at least {PASSWORD_MIN_LENGTH} characters long, with a letter and a digit.
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
          New password
          <input
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={input}
          />
        </label>
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: 'var(--text-secondary)',
            fontSize: 14,
          }}
        >
          Confirm password
          <input
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={input}
          />
        </label>
        <button type="submit" disabled={busy || done} style={btn}>
          {busy ? 'Saving…' : done ? 'Saved' : 'Set new password'}
        </button>
      </form>

      {error && (
        <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>
          {error}
        </p>
      )}
      {done && !error && (
        <p role="status" style={{ color: 'var(--status-done, #6c6)', margin: 0, fontSize: 14 }}>
          Password updated. Redirecting…
        </p>
      )}
    </div>
  );
}
