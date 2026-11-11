import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
import BillingButton, { CreditPackCheckout, PackBuyButton } from '@/components/BillingButton';

export const metadata: Metadata = { title: 'Pricing', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

type Plan = {
  code: string;
  display_name: string;
  // CAD cents per TSD §1.2 — Stripe sandbox is a BC CAD catalog. Column
  // renamed from price_usd_cents in migration 016_v3_rename_price_cad.sql.
  price_cad_cents: number;
  monthly_job_quota: number;
  services: string[];
  export_stems: boolean;
  export_wav24: boolean;
};

type CreditPack = {
  pack_code: 'credits_20' | 'credits_60' | 'credits_180';
  credits: number;
  price_cad_cents: number;
  display_name: string;
};

// Fallback if public.plans is unreachable, so the page still renders (TSD §1.2).
// Must mirror migration 034_v3_pricing_model_truth.sql, which is the source of
// truth for plan values. Kept in step by pricing-features-table.test.mjs, which
// parses 034 and compares it to this array field by field — so a migration that
// changes a plan value and leaves this stale fails the suite.
const FALLBACK: Plan[] = [
  { code: 'free', display_name: 'Free', price_cad_cents: 0, monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'pro', display_name: 'Pro', price_cad_cents: 499, monthly_job_quota: 50, services: [], export_stems: false, export_wav24: false },
  { code: 'studio', display_name: 'Studio', price_cad_cents: 1200, monthly_job_quota: 150, services: [], export_stems: false, export_wav24: false },
];

// Fallback for the one-time credit SKUs if public.credit_packs is unreachable.
// Source of truth lives in that table (migration 020); this mirror only runs
// in degraded mode so the page still renders during a Postgres outage.
// Audit MINOR (session-4): previously the only source — migrated to DB-driven
// to parallel the `plans` catalog and avoid a code deploy for price changes.
const CREDIT_PACKS_FALLBACK: CreditPack[] = [
  { pack_code: 'credits_20',  credits: 20,  price_cad_cents: 500,  display_name: '20 credits'  },
  { pack_code: 'credits_60',  credits: 60,  price_cad_cents: 1200, display_name: '60 credits'  },
  { pack_code: 'credits_180', credits: 180, price_cad_cents: 3000, display_name: '180 credits' },
];

function priceCad(cents: number): string {
  const dollars = cents / 100;
  const whole = dollars === Math.floor(dollars);
  return `$${whole ? dollars.toString() : dollars.toFixed(2)} CAD`;
}

async function loadPlans(): Promise<{ plans: Plan[]; degraded: boolean }> {
  try {
    const r = await db.query(
      `SELECT code, display_name, price_cad_cents, monthly_job_quota, services, export_stems, export_wav24
         FROM public.plans WHERE active = true`,
    );
    const rows = r.rows as Plan[];
    const order = ['free', 'pro', 'studio'];
    const plans = order.map((c) => rows.find((p) => p.code === c)).filter((p): p is Plan => !!p);
    if (plans.length) return { plans, degraded: false };
  } catch (err) {
    // Silently swallowing the error hides exactly what we need to see when
    // staging/prod degrade to FALLBACK. Log it so Vercel runtime logs (and
    // Sentry's console-integration) capture the cause, then fall through.
    console.error('[pricing] loadPlans query failed; serving FALLBACK:', err);
  }
  return { plans: FALLBACK, degraded: true };
}

async function loadCreditPacks(): Promise<{ packs: CreditPack[]; degraded: boolean }> {
  try {
    const r = await db.query(
      `SELECT pack_code, credits, price_cad_cents, display_name
         FROM public.credit_packs WHERE active = true`,
    );
    const rows = r.rows as CreditPack[];
    // Stable display order — smallest pack first, same as the hardcoded list
    // used to render. A row missing from the DB falls through (no entry); a
    // row present with an unknown pack_code is skipped (defensive: only the
    // three TSD-locked SKUs render as buy buttons, per /api/billing/checkout
    // which validates pack_code against the same enum).
    const order: CreditPack['pack_code'][] = ['credits_20', 'credits_60', 'credits_180'];
    const packs = order
      .map((pc) => rows.find((p) => p.pack_code === pc))
      .filter((p): p is CreditPack => !!p);
    if (packs.length) return { packs, degraded: false };
  } catch (err) {
    console.error('[pricing] loadCreditPacks query failed; serving FALLBACK:', err);
  }
  return { packs: CREDIT_PACKS_FALLBACK, degraded: true };
}

// Plans are priced in CAD cents per TSD §1.2. Append " CAD" so the UI never
// reads as implied USD — audit MAJOR finding (sandbox is BC CAD catalog).
// $0 renders without a currency tag (free is currency-neutral in copy).
const price = (c: number) => {
  if (c === 0) return '$0';
  return `$${(c / 100).toFixed(c % 100 ? 2 : 0)} CAD`;
};
// Link-import services that are ACTUALLY IMPLEMENTED, and therefore the only
// ones this page may name. Spotify and SoundCloud were listed here and carried
// on the free plan row, so the page advertised both — neither has a downloader,
// a route or an error code anywhere in the repo. Migration 034 drops them from
// `plans.services`; this map is the second half of the same fix, so a row that
// re-acquires an unbuilt service still cannot be advertised. An unrecognised
// service is dropped, never printed raw: the old `?? s` fallback would have
// rendered a bare "spotify" straight from the database.
const SERVICE_LABEL: Record<string, string> = { youtube: 'YouTube' };

// `plans.monthly_job_quota` counts TRACKS CONVERTED TO PLAY-ALONG, and the
// enforcement is checkMonthlyQuota() comparing entitlements.jobs_used against
// it, rolled to the current calendar month. Both halves of that sentence are
// stated here because the previous copy got both wrong: it said "3 songs per
// day" (a daily period that nothing implements) for every plan under the
// unlimited sentinel, so the number on the page was not the number in the
// column and changing the column could not change the page.
const QUOTA_PERIOD = 'month';

/** The quota sentence, derived from the column rather than typed. */
export function quotaLine(p: Plan): string {
  const n = p.monthly_job_quota;
  return `${n} ${n === 1 ? 'track' : 'tracks'} converted to play-along per ${QUOTA_PERIOD}`;
}

/** The feature bullets for one plan.
 *
 *  Every bullet must be something the app can deliver for THAT plan today:
 *
 *   - the quota sentence is read off the column (above);
 *   - link import is named only for implemented services the row actually
 *     carries, and its ABSENCE is not rendered as a bullet. The old code
 *     pushed "File uploads only (no link import)" on the paid tiers, which
 *     turned $4.99 into an advertised loss of a free-tier feature;
 *   - 24-bit WAV loop download is listed for every plan because that is the
 *     truth: worker/encoder/wav_encoder.py writes PCM_24 for all loops and the
 *     landing page has always offered it with no account. It is a real feature
 *     and NOT a paid differentiator, so it is not gated on export_wav24.
 *
 *  Deliberately absent: "Stem export". There is no stem-export route —
 *  /api/jobs/[id]/stems serves Opus playback urls and says so, and
 *  mintStemDownloadUrl() has no production caller. Migration 034 sets
 *  export_stems false on every plan to match. */
export function features(p: Plan): string[] {
  const out: string[] = [];
  out.push(quotaLine(p));
  const named = p.services.map((s) => SERVICE_LABEL[s]).filter((l): l is string => !!l);
  if (named.length) out.push(`Link import: ${named.join(', ')}`);
  out.push('Loop download — 24-bit WAV');
  return out;
}

const card = {
  border: '1px solid var(--border-default, #333)', borderRadius: 12, padding: 20,
  background: 'var(--bg-card, #151515)', display: 'flex', flexDirection: 'column' as const, gap: 12,
};

export default async function PricingPage() {
  const [{ plans, degraded: plansDegraded }, { packs, degraded: packsDegraded }, user] = await Promise.all([
    loadPlans(),
    loadCreditPacks(),
    getUser().catch(() => null),
  ]);
  // Either catalog being on FALLBACK is enough to show the banner — the two
  // live in the same DB and typically degrade together.
  const degraded = plansDegraded || packsDegraded;

  // The V3-C10 trial banner used to render here, directly above the Free card.
  // It pitched a three-track signup offer to every signed-out viewer, while the
  // Free card beside it offers five tracks a month and asks for no account at
  // all: two different free amounts in one viewport, the smaller of them
  // gated behind a signup. Removed rather than re-numbered, because the trial
  // cap is enforced by a CHECK constraint in migration 013 and by the shared
  // constant in lib/trial.ts, so making the banner agree with the Free tier
  // would take a second migration to raise that cap -- for a nudge that now
  // offers strictly less than doing nothing. The /trial route is untouched and
  // still works for anyone who reaches it.

  return (
    <main style={{ minHeight: '100dvh', padding: '24px 16px', maxWidth: 960, margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 28, margin: 0, color: 'var(--text-primary)' }}>Pricing</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>
        Every plan converts tracks to play-along and downloads loops as 24-bit WAV. Plans differ in
        how many tracks you can convert each month.
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
              {price(p.price_cad_cents)}
              {p.price_cad_cents > 0 && <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)' }}> /mo</span>}
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
                body={{ plan_code: p.code }}
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
      <CreditPackCheckout returnTo="/pricing">
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))' }}>
        {packs.map((c) => (
          <section key={c.pack_code} style={card} aria-label={`${c.credits} credits for ${priceCad(c.price_cad_cents)}`}>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary)' }}>{c.credits} credits</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
              {priceCad(c.price_cad_cents)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Never expires · one-time purchase
            </div>
            {user ? (
              <PackBuyButton packCode={c.pack_code} label="Buy Credits" />
            ) : (
              <a href="/login?return_to=/pricing" style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'var(--btn-primary-bg, var(--accent))', color: 'var(--btn-primary-text, #000)', textDecoration: 'none', fontWeight: 600 }}>
                Buy Credits
              </a>
            )}
          </section>
        ))}
      </div>
      </CreditPackCheckout>
    </main>
  );
}
