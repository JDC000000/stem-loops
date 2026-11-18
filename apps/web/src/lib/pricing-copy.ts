// The /pricing feature bullets, derived from the plan row.
//
// This lives outside `app/pricing/page.tsx` because a Next.js App Router page
// may only export a fixed set of fields (`default`, `metadata`, `dynamic`, …).
// Exporting `features`/`benefitLine` from the page compiled under
// `tsc --noEmit` but failed `next build` with:
//
//   Type error: Page "src/app/pricing/page.tsx" does not match the required
//   types of a Next.js Page.  "quotaLine" is not a valid Page export field.
//
// A separate module is also what makes the bullets testable without pulling
// `next`, `@/lib/db` and a client component into the test process.
//
// ---------------------------------------------------------------------------
// The defect this file exists to prevent
//
// `features()` used to key the quota sentence off `monthly_job_quota >= 100000`
// and otherwise print the literal '3 songs per day, no account needed'. So the
// number on the page was not the number in the column, and **changing the
// quota could not change the page** — it said "3 songs per day" for a plan
// metered at 90 per month. Every bullet here is now either read off the row or
// true of every plan.
//
// Gated by `apps/web/test/pricing-features-table.test.mjs`, which checks the
// output against migrations 034 + 037 AND against a ban list of capabilities a
// buyer cannot actually reach in the app.

/** The plan fields the copy needs. Structurally satisfied by the page's `Plan`
 *  and by a row from `public.plans`. */
export type PlanCopyInput = {
  monthly_job_quota: number;
  services: string[];
  /** plans.code. Drives the retention bullet; absent or unknown -> no retention bullet. */
  code?: string;
};

/** How long each plan keeps a song (Jon, 2026-11-15). Free's 24 hours is exact
 *  (jobs.expires_at, migration 007); Pro and Studio is JOB_RETAINED_UNTIL_SQL in
 *  lib/retention.ts and RETAINED_UNTIL_SQL in the worker's cleanup.py. */
export const RETENTION_BULLET: Readonly<Record<string, string>> = {
  free: 'Songs deleted after 24 hours',
  pro: 'Song library: kept while you subscribe, plus 30 days',
  studio: 'Song library: kept while you subscribe, plus 30 days',
};

// Link-import services that are ACTUALLY IMPLEMENTED, and therefore the only
// ones this page may name. Spotify and SoundCloud were listed here and carried
// on the free plan row, so the page advertised both — neither has a downloader,
// a route or an error code anywhere in the repo. Migration 034 drops them from
// `plans.services`; this map is the second half of the same fix, so a row that
// re-acquires an unbuilt service still cannot be advertised. An unrecognised
// service is dropped, never printed raw: the old `?? s` fallback would have
// rendered a bare "spotify" straight from the database.
export const SERVICE_LABEL: Record<string, string> = { youtube: 'YouTube' };

// `plans.monthly_job_quota` counts songs converted to play-along, and the
// enforcement is checkMonthlyQuota() comparing entitlements.jobs_used against
// it, rolled to the current calendar month. The period is stated here because
// the previous copy said "per day", which no code implements.
export const QUOTA_PERIOD = 'month';

/** The quota, stated ONCE per card (design P6; Slice 1b follow-up). Each card
 *  used to say it twice — "50 songs a month" as the lead line and "50 tracks
 *  converted to play-along per month" as the first bullet. This line is now
 *  the only one, read off monthly_job_quota, in the word the rest of the site
 *  uses ("songs"). Deliberately the quota ONLY: retention is stated once per
 *  card, in RETENTION_BULLET's exact wording, among the bullets, so there is
 *  no second, paraphrased retention promise to drift from it. */
export function benefitLine(p: PlanCopyInput): string {
  const n = p.monthly_job_quota;
  return `${n} ${n === 1 ? 'song' : 'songs'} a ${QUOTA_PERIOD}`;
}

/** The feature bullets for one plan.
 *
 *  Every bullet must be something the app can deliver for THAT plan today:
 *
 *   - the quota is NOT a bullet: benefitLine() above states it once;
 *   - link import is named only for implemented services the row actually
 *     carries. Its ABSENCE is rendered only as the neutral 'Works with audio
 *     files you upload' (audit F14), never as a loss. The old code
 *     pushed "File uploads only (no link import)" on the paid tiers, which
 *     turned $4.99 into an advertised loss of a free-tier feature;
 *   - 24-bit WAV loop download is listed for every plan because that is the
 *     truth: worker/encoder/wav_encoder.py writes PCM_24 for all loops and the
 *     landing page has always offered it with no account. It is a real feature
 *     and NOT a paid differentiator, so it is not gated on export_wav24.
 *
 *  Deliberately absent, for now: "Stem export". Migration 037 sets
 *  export_stems true on Studio and GET /api/jobs/[id]/download enforces it,
 *  but nothing in the UI calls that route yet, so a Studio buyer would have
 *  no way to find the feature the bullet promised. The bullet ships with the
 *  download button: when that lands, gate a "Stem export" bullet on
 *  p.export_stems here AND change "turning export flags on cannot add a
 *  bullet" in pricing-features-table.test.mjs in the same change. */
export function features(p: PlanCopyInput): string[] {
  const out: string[] = [];
  const named = p.services.map((s) => SERVICE_LABEL[s]).filter((l): l is string => !!l);
  if (named.length) out.push(`Link import: ${named.join(', ')}`);
  // No implemented link service (no plan since 039 gave Pro and Studio YouTube): say what
  // the plan works on, neutrally.
  // Never a negative bullet: pricing-features-table.test.mjs bans "uploads only".
  else out.push('Works with audio files you upload');
  out.push('Loop download — 24-bit WAV');
  const keep = p.code ? RETENTION_BULLET[p.code] : undefined;
  if (keep) out.push(keep);
  return out;
}

// ─── what each plan card offers, by who is looking (QA A-10, 2026-11-18) ──────
// Signed in, /pricing was not plan-aware: a Free user was offered "Start free" (a
// link home) and a Pro subscriber "Get Pro". Display only — checkout is untouched.
//
// MONEY RULE (review of #301, F-1/F-2/R2-2): /api/billing/checkout opens a NEW
// subscription (Stripe mode 'subscription') and does not check for an existing one.
// So the page offers a plan checkout only when the caller passes current = 'free',
// which pricing/page.tsx does only for a viewer whose effective plan is Free AND who
// has no live subscription row (lib/billing/pricing-plan-state.ts). Everyone else —
// Pro/Studio, a live-but-effectively-free subscription, an unreadable plan — is sent
// to /account (the billing portal). This is a DISPLAY rule: it does not stop a
// direct POST to checkout; that needs the server-side guard (follow-up [billing] PR).
//   * signed out: unchanged (Start free, and Get <plan> through sign-in, Pro lime);
//   * Free: "Current plan" on Free (neutral, not a control); checkout for paid
//     plans, Pro carrying the highlight and the page's one lime fill;
//   * Pro / Studio: "Current plan" on theirs; "Change plan" (another paid plan) or
//     "Manage plan" (Free), quiet links to /account; no highlight, no lime;
//   * plan unknown (read failed, or a code this page does not know): quiet
//     "Manage plan" links to /account on every card and a neutral note; no lime.
export type PlanCta =
  | { kind: 'start-free' }
  | { kind: 'sign-in'; primary: boolean }
  | { kind: 'checkout'; primary: boolean }
  | { kind: 'current' }
  | { kind: 'manage' }
  | { kind: 'change' };

const PLAN_RANK: Readonly<Record<string, number>> = { free: 0, pro: 1, studio: 2 };
/** The viewer's plan when it is one this page knows, else null (treated as unknown). */
const knownPlan = (current: string | null): string | null => (current !== null && current in PLAN_RANK ? current : null);

/** The plan code that gets the highlight and the one lime action, or null for none. */
export function featuredPlan(planCodes: readonly string[], signedIn: boolean, current: string | null): string | null {
  // Signed out, or signed in on Free: Pro. Anyone else gets no checkout, so nothing is featured.
  if (!signedIn || knownPlan(current) === 'free') return planCodes.includes('pro') ? 'pro' : null;
  return null;
}

/** What the card for `code` offers this viewer. `current` is null when unknown. */
export function planCta(code: string, signedIn: boolean, current: string | null, featured: string | null): PlanCta {
  if (!signedIn) return code === 'free' ? { kind: 'start-free' } : { kind: 'sign-in', primary: code === featured };
  const plan = knownPlan(current);
  if (plan === null) return { kind: 'manage' };
  if (code === plan) return { kind: 'current' };
  if (plan === 'free') return { kind: 'checkout', primary: code === featured };
  // A paying viewer: never a checkout (it would open a second subscription).
  return code === 'free' ? { kind: 'manage' } : { kind: 'change' };
}
