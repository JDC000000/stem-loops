'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import HCaptcha from '@hcaptcha/react-hcaptcha';

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
        style={buttonStyle(primary, busy)}
      >
        {busy ? 'Redirecting…' : label}
      </button>
      {error && <p role="alert" style={{ color: 'var(--status-failed, #f66)', fontSize: 13, margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}

function buttonStyle(primary: boolean, busy: boolean) {
  return {
    width: '100%', minHeight: 44, padding: '0 16px', borderRadius: 8, cursor: busy ? 'wait' : 'pointer',
    fontWeight: 600,
    border: primary ? 'none' : '1px solid var(--border-default, #444)',
    background: primary ? 'var(--btn-primary-bg, var(--accent))' : 'transparent',
    color: primary ? 'var(--btn-primary-text, #000)' : 'var(--text-primary)',
    opacity: busy ? 0.7 : 1,
  } as const;
}

// ---------------------------------------------------------------------------
// Credit-pack checkout (V3-C1 bot gate) — ONE hCaptcha for the whole page.
//
// Design: tapping "Buy Credits" on a pack selects it and reveals a single
// full-width verification panel below the grid. Solving the captcha submits
// checkout immediately, so the token is never held: hCaptcha tokens are
// single-use and expire after 120s (docs.hcaptcha.com), which rules out
// solving up front and carrying a token while the user compares packs.
// The widget lives outside the cards, so card width can no longer clip it.
// ---------------------------------------------------------------------------
type PackCtx = {
  selected: string | null;
  busy: boolean;
  select: (packCode: string) => void;
};
const PackContext = createContext<PackCtx | null>(null);

export function CreditPackCheckout({ children, returnTo }: { children: ReactNode; returnTo: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captchaRef = useRef<HCaptcha>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;

  useEffect(() => {
    if (selected) panelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  function select(packCode: string) {
    if (busy) return;
    // Picking a different pack discards any half-solved challenge.
    if (selected && selected !== packCode) captchaRef.current?.resetCaptcha();
    setError(null);
    setSelected(packCode);
  }

  async function submit(token: string) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pack_code: selected, hcaptcha_token: token }),
      });
      if (res.status === 401) {
        window.location.href = `/login?return_to=${encodeURIComponent(returnTo)}`;
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { checkout_url?: string };
      if (!json.checkout_url) throw new Error('no url');
      window.location.href = json.checkout_url;
    } catch {
      // Token is spent either way; force a fresh challenge for the retry.
      captchaRef.current?.resetCaptcha();
      setError('Billing is temporarily unavailable. Please try again shortly.');
      setBusy(false);
    }
  }

  return (
    <PackContext.Provider value={{ selected, busy, select }}>
      {children}
      {selected && (
        <div
          ref={panelRef}
          role="group"
          aria-label="Verify you are human to continue to checkout"
          style={{
            marginTop: 16, padding: 16, borderRadius: 12, boxSizing: 'border-box', maxWidth: '100%',
            border: '1px solid var(--border-default, #333)', background: 'var(--bg-card, #151515)',
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12,
          }}
        >
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {busy ? 'Redirecting to checkout…' : 'Quick check, then you go straight to checkout.'}
          </div>
          {siteKey ? (
            // overflow-x guard: if the real widget is ever wider than the
            // viewport it scrolls inside this box instead of the page.
            <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
              <HCaptcha
                ref={captchaRef}
                sitekey={siteKey}
                onVerify={(t) => { void submit(t); }}
                onError={() => setError('Bot check failed to load. Please try again.')}
              />
            </div>
          ) : (
            <p role="alert" style={{ color: 'var(--status-failed, #f66)', fontSize: 13, margin: 0 }}>
              Bot check is unavailable. Please try again later.
            </p>
          )}
          {error && <p role="alert" style={{ color: 'var(--status-failed, #f66)', fontSize: 13, margin: 0 }}>{error}</p>}
          <button
            type="button"
            onClick={() => { setSelected(null); setError(null); }}
            disabled={busy}
            style={{ minHeight: 44, padding: '0 8px', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Cancel
          </button>
        </div>
      )}
    </PackContext.Provider>
  );
}

// Per-card button. Must render inside <CreditPackCheckout>.
export function PackBuyButton({ packCode, label }: { packCode: string; label: string }) {
  const ctx = useContext(PackContext);
  const active = ctx?.selected === packCode;
  return (
    <button
      type="button"
      onClick={() => ctx?.select(packCode)}
      disabled={!ctx || ctx.busy}
      aria-pressed={active}
      style={{ ...buttonStyle(true, Boolean(ctx?.busy)), outline: active ? '2px solid var(--text-primary)' : undefined, outlineOffset: 2 }}
    >
      {label}
    </button>
  );
}
