'use client';

// One-time flash banner driven by `?flash=<key>`. Shown once on load, then the
// param is stripped from the URL (history.replaceState) so a refresh or
// shared link doesn't replay it.

import { useEffect, useState } from 'react';

const MESSAGES: Record<string, string> = {
  account_deleted: 'Account deleted',
};

export default function FlashBanner() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const key = url.searchParams.get('flash');
      if (!key) return;
      url.searchParams.delete('flash');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      if (Object.prototype.hasOwnProperty.call(MESSAGES, key)) setMsg(MESSAGES[key]);
    } catch {
      /* non-critical */
    }
  }, []);

  if (!msg) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
        maxWidth: 'calc(100vw - 32px)', padding: '10px 16px', borderRadius: 'var(--radius-md)', zIndex: 1000,
        background: 'var(--bg-card, #151515)', color: 'var(--text-primary)',
        border: '1px solid var(--border-default, #444)', fontSize: 14,
        display: 'flex', gap: 12, alignItems: 'center',
      }}
    >
      <span>{msg}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setMsg(null)}
        // 44 x 44 touch target (brand book §8, M25); it was 32 x 32
        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', minHeight: 'var(--touch-min)', minWidth: 'var(--touch-min)' }}
      >
        ×
      </button>
    </div>
  );
}
