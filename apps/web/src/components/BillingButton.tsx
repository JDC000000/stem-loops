'use client';

import { useState } from 'react';

type Props = {
  label: string;
  endpoint: '/api/billing/checkout' | '/api/billing/portal';
  body?: Record<string, string>;
  returnTo: string;
  primary?: boolean;
};

// POSTs to a /api/billing/* route and follows the returned URL. 401 -> login.
export default function BillingButton({ label, endpoint, body, returnTo, primary = true }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (res.status === 401) {
        window.location.href = `/login?return_to=${encodeURIComponent(returnTo)}`;
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { checkout_url?: string; portal_url?: string };
      const url = json.checkout_url ?? json.portal_url;
      if (!url) throw new Error('no url');
      window.location.href = url;
    } catch {
      setError('Billing is temporarily unavailable. Please try again shortly.');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        style={{
          width: '100%', minHeight: 44, padding: '0 16px', borderRadius: 8, cursor: busy ? 'wait' : 'pointer',
          fontWeight: 600,
          border: primary ? 'none' : '1px solid var(--border-default, #444)',
          background: primary ? 'var(--btn-primary-bg, var(--accent))' : 'transparent',
          color: primary ? 'var(--btn-primary-text, #000)' : 'var(--text-primary)',
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? 'Redirecting…' : label}
      </button>
      {error && <p role="alert" style={{ color: 'var(--status-failed, #f66)', fontSize: 13, margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}
