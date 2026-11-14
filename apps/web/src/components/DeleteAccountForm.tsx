'use client';

// Type-to-confirm account deletion. The submit button stays disabled until
// the typed text equals the user's own email. The server re-checks.

import { useState, type FormEvent } from 'react';
import { createBrowserClient } from '@/lib/auth/supabase';
import { clearBufferedEdits } from '@/chord/edit-collector';
import { fieldStyle, buttonBase } from '@/lib/ui/form-styles';

const input = fieldStyle;

export default function DeleteAccountForm({ email }: { email: string }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/users/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_email: typed.trim() }),
      });
      if (res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        setError(
          typeof body?.error === 'string'
            ? body.error
            : "We couldn't delete your account. Please try again.",
        );
        setBusy(false);
        return;
      }
      // Auth user is gone; clear the now-dead session cookies locally and
      // drop any buffered chord edits so they can't be flushed under the
      // next user's session (security audit §3 M3).
      try {
        clearBufferedEdits();
      } catch {
        /* non-fatal; buffer is best-effort anyway */
      }
      try {
        await createBrowserClient().auth.signOut({ scope: 'local' });
      } catch {
        /* cookies are invalid server-side anyway */
      }
      window.location.assign('/?flash=account_deleted');
    } catch {
      setError("We couldn't delete your account. Please try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)', fontSize: 14 }}>
        Type your email address <strong style={{ overflowWrap: 'anywhere' }}>{email}</strong> to confirm
        <input
          type="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          style={input}
        />
      </label>
      <button
        type="submit"
        disabled={!matches || busy}
        style={{
          ...buttonBase,
          // the failed red from the token file, not an off-palette red (brand book M23):
          // #0d0d0d on #ff5f5f is 6.53:1 (white on it would be 2.98:1)
          border: 'none',
          background: 'var(--status-failed)',
          color: 'var(--text-inverse)',
          cursor: !matches || busy ? 'not-allowed' : 'pointer',
          opacity: !matches || busy ? 0.5 : 1,
          boxSizing: 'border-box',
        }}
      >
        {busy ? 'Deleting…' : 'Permanently delete my account'}
      </button>
      {error && (
        <p role="alert" style={{ color: 'var(--status-failed, #f66)', margin: 0, fontSize: 14 }}>
          {error}
        </p>
      )}
    </form>
  );
}
