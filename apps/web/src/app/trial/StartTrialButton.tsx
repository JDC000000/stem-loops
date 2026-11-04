'use client';

// Start-trial button — V3 Phase 1a (TSD §1.6, V3-C10).
//
// POSTs /api/users/me/trial/grant and reloads the page on success so the
// server-rendered /trial state flips from "no grant" to "active" without
// drift between the two views. Idempotent on the server side; a double-
// click just reads the existing row.

import { useState } from 'react';

export default function StartTrialButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/users/me/trial/grant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (res.status === 401) {
        window.location.href = '/login?return_to=/trial';
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      // Re-render the server component with fresh trial_grants state.
      window.location.reload();
    } catch {
      setError('Trial is temporarily unavailable. Please try again shortly.');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        style={{
          width: '100%',
          minHeight: 44,
          padding: '0 16px',
          borderRadius: 8,
          border: 'none',
          background: 'var(--btn-primary-bg, var(--accent))',
          color: 'var(--btn-primary-text, #000)',
          fontWeight: 600,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? 'Starting…' : 'Start trial'}
      </button>
      {error && (
        <p role="alert" style={{ color: 'var(--status-failed, #f66)', fontSize: 13, margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </div>
  );
}
