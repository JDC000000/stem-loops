import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
import BillingButton from '@/components/BillingButton';

export const metadata: Metadata = { title: 'Pricing' };
export const dynamic = 'force-dynamic';

type Plan = {
  code: string;
  display_name: string;
  price_usd_cents: number;
  monthly_job_quota: number;
  services: string[];
  export_stems: boolean;
  export_wav24: boolean;
};

// Fallback if public.plans is unreachable, so the page still renders (TSD §1.2).
const FALLBACK: Plan[] = [
  { code: 'free', display_name: 'Free', price_usd_cents: 0, monthly_job_quota: 90, services: ['youtube', 'spotify', 'soundcloud'], export_stems: false, export_wav24: false },
  { code: 'pro', display_name: 'Pro', price_usd_cents: 499, monthly_job_quota: 100000, services: [], export_stems: true, export_wav24: false },
  { code: 'studio', display_name: 'Studio', price_usd_cents: 1200, monthly_job_quota: 100000, services: [], export_stems: true, export_wav24: true },
];

// One-time credit SKUs, hardcoded per TSD §1.2 (not modeled in public.plans).
const CREDIT_PACKS = [
  { pack_code: 'credits_20', credits: 20 },
  { pack_code: 'credits_60', credits: 60 },
  { pack_code: 'credits_180', credits: 180 },
];

// Checkout plan codes (billing/types.ts PlanCode) keyed by public.plans.code.
const CHECKOUT_CODE: Record<string, string> = { pro: 'pro_monthly', studio: 'studio_monthly' };

async function loadPlans(): Promise<{ plans: Plan[]; degraded: boolean }> {
  try {
    const r = await db.query(
      `SELECT code, display_name, price_usd_cents, monthly_job_quota, services, export_stems, export_wav24
         FROM public.plans WHERE active = true`,
    );
    const rows = r.rows as Plan[];
    const order = ['free', 'pro', 'studio'];
    const plans = order.map((c) => rows.find((p) => p.code === c)).filter((p): p is Plan => !!p);
    if (plans.length) return { plans, degraded: false };
  } catch {
    // fall through to fallback
  }
  return { plans: FALLBACK, degraded: true };
}

const price = (c: number) => (c === 0 ? '$0' : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`);
const SERVICE_LABEL: Record<string, string> = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud' };

function features(p: Plan): string[] {
  const out: string[] = [];
  out.push(p.monthly_job_quota >= 100000 ? 'Unlimited own-file uploads' : '3 songs per day, no account needed');
  out.push(p.services.length ? `Link import: ${p.services.map((s) => SERVICE_LABEL[s] ?? s).join(', ')}` : 'File uploads only (no link import)');
  out.push(p.export_stems ? 'Stem export' : 'Loop export');
  if (p.export_wav24) out.push('24-bit WAV export');
  return out;
}

const card = {
  border: '1px solid var(--border-default, #333)', borderRadius: 12, padding: 20,
  background: 'var(--bg-card, #151515)', display: 'flex', flexDirection: 'column' as const, gap: 12,
};

export default async function PricingPage() {
  const [{ plans, degraded }, user] = await Promise.all([loadPlans(), getUser().catch(() => null)]);

  return (
    <main style={{ minHeight: '100dvh', padding: '24px 16px', maxWidth: 960, margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 28, margin: 0, color: 'var(--text-primary)' }}>Pricing</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>
        Free forever for link import. Upgrade for unlimited own-file work and higher-quality exports.
      </p>
      {degraded && (
        <p role="status" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Showing standard pricing; live plan data is temporarily unavailable.
        </p>
      )}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 16 }}>
        {plans.map((p) => (
          <section key={p.code} style={card} aria-label={p.display_name}>
            <h2 style={{ margin: 0, fontSize: 20, color: 'var(--text-primary)' }}>{p.display_name}</h2>
            <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--text-primary)' }}>
              {price(p.price_usd_cents)}
              {p.price_usd_cents > 0 && <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)' }}> /mo</span>}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 14, display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              {features(p).map((f) => <li key={f}>{f}</li>)}
            </ul>
            {p.code === 'free' ? (
              <a href="/" style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--border-default, #444)', textDecoration: 'none', color: 'var(--text-primary)' }}>
                Start free
              </a>
            ) : user ? (
              <BillingButton
                label={`Get ${p.display_name}`}
                endpoint="/api/billing/checkout"
                body={{ plan_code: CHECKOUT_CODE[p.code] ?? p.code }}
                returnTo="/pricing"
              />
            ) : (
              <a href="/login?return_to=/pricing" style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'var(--btn-primary-bg, var(--accent))', color: 'var(--btn-primary-text, #000)', textDecoration: 'none', fontWeight: 600 }}>
                Get {p.display_name}
              </a>
            )}
          </section>
        ))}
      </div>

      <h2 style={{ fontSize: 22, marginTop: 32, color: 'var(--text-primary)' }}>Credits</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>One-time packs. Credits never expire.</p>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {CREDIT_PACKS.map((c) => (
          <section key={c.pack_code} style={card} aria-label={`${c.credits} credits`}>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary)' }}>{c.credits} credits</div>
            {user ? (
              <BillingButton label="Buy Credits" endpoint="/api/billing/checkout" body={{ pack_code: c.pack_code }} returnTo="/pricing" />
            ) : (
              <a href="/login?return_to=/pricing" style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'var(--btn-primary-bg, var(--accent))', color: 'var(--btn-primary-text, #000)', textDecoration: 'none', fontWeight: 600 }}>
                Buy Credits
              </a>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
