import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
import BillingButton, { CreditPackCheckout, PackBuyButton } from '@/components/BillingButton';
// The feature bullets live in their own module: a Next.js App Router page may
// only export a fixed set of fields, so exporting features()/quotaLine() from
// here passed `tsc --noEmit` but failed `next build`.
import { benefitLine, features } from '@/lib/pricing-copy';

// P6 (Jon, 2026-11-17): /pricing is a public, indexable page. Its metadata comes
// from the page registry (lib/seo/pages.ts) and is declared in ./layout.tsx, as
// /loops does: this page stays free of the SEO modules so the pricing tests can
// keep loading it in isolation.
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
// Must mirror the catalog the migration chain leaves: 034_v3_pricing_model_truth.sql
// for every value, with 037_v3_studio_stem_export.sql's override on top (studio
// export_stems true) and 039_v3_paid_plans_youtube_links.sql's (pro/studio
// services ['youtube']). Kept in step by pricing-features-table.test.mjs, which
// parses 034, applies 037's and 039's UPDATEs, and compares the result to this
// array field by field — so a migration that changes a plan value and leaves
// this stale fails the suite.
const FALLBACK: Plan[] = [
  { code: 'free', display_name: 'Free', price_cad_cents: 0, monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'pro', display_name: 'Pro', price_cad_cents: 499, monthly_job_quota: 50, services: ['youtube'], export_stems: false, export_wav24: false },
  { code: 'studio', display_name: 'Studio', price_cad_cents: 1200, monthly_job_quota: 150, services: ['youtube'], export_stems: true, export_wav24: false },
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

// Plans are priced in CAD cents per TSD §1.2, so every price, Free's $0
// included, carries " CAD" (design P6 / copy rules: prices always with
// currency). One formatter for plans and packs.
const price = priceCad;

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
    <main className="pr-wrap">
      <h1 className="pr-h1">Pricing</h1>
      <p className="pr-lede">Every plan includes the player and loop downloads. Plans differ in songs per month and how long they are kept.</p>
      {degraded && (
        <p role="status" className="pr-note">
          Showing standard pricing; live plan data is temporarily unavailable.
        </p>
      )}

      <div className="pr-plans">
        {plans.map((p) => {
          // Pro carries the highlight (design P6): a white edge on the selected
          // surface, and the page's one lime action. No badge or "recommended" /
          // "most popular" text: there is no data behind either claim.
          const featured = p.code === 'pro';
          return (
            <section key={p.code} className={`pr-card${featured ? ' pr-featured' : ''}`} aria-label={p.display_name}>
              <h2 className="pr-name">{p.display_name}</h2>
              <p className="pr-benefit">{benefitLine(p)}</p>
              <div className="pr-price">
                {price(p.price_cad_cents)}
                {p.price_cad_cents > 0 && <span className="pr-per"> /mo</span>}
              </div>
              <ul className="pr-features">
                {features(p).map((f) => <li key={f}>{f}</li>)}
              </ul>
              {p.code === 'free' ? (
                <a href="/" className="pr-cta pr-cta-quiet">
                  Start free
                </a>
              ) : user ? (
                <BillingButton
                  label={`Get ${p.display_name}`}
                  endpoint="/api/billing/checkout"
                  body={{ plan_code: p.code }}
                  returnTo="/pricing"
                  primary={featured}
                />
              ) : (
                <a href="/login?return_to=/pricing" className={featured ? 'pr-cta jp-primary' : 'pr-cta pr-cta-quiet'}>
                  Get {p.display_name}
                </a>
              )}
            </section>
          );
        })}
      </div>

      <h2 className="pr-h2">Credits</h2>
      <p className="pr-lede">One credit is one uploaded track on the Free plan. Credits never expire.</p>
      <CreditPackCheckout returnTo="/pricing">
      <div className="pr-packs">
        {packs.map((c) => (
          <section key={c.pack_code} className="pr-card" aria-label={`${c.credits} credits for ${priceCad(c.price_cad_cents)}`}>
            <div className="pr-pack-credits">{c.credits} credits</div>
            <div className="pr-pack-price">
              {priceCad(c.price_cad_cents)}
            </div>
            {user ? (
              <PackBuyButton packCode={c.pack_code} label="Buy credits" />
            ) : (
              <a href="/login?return_to=/pricing" className="pr-cta pr-cta-quiet">
                Buy credits
              </a>
            )}
          </section>
        ))}
      </div>
      </CreditPackCheckout>
    </main>
  );
}
