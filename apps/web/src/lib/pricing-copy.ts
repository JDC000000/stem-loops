// The /pricing feature bullets, derived from the plan row.
//
// This lives outside `app/pricing/page.tsx` because a Next.js App Router page
// may only export a fixed set of fields (`default`, `metadata`, `dynamic`, …).
// Exporting `features`/`quotaLine` from the page compiled under
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

// `plans.monthly_job_quota` counts TRACKS CONVERTED TO PLAY-ALONG, and the
// enforcement is checkMonthlyQuota() comparing entitlements.jobs_used against
// it, rolled to the current calendar month. Both halves of that sentence are
// stated here because the previous copy got both wrong.
export const QUOTA_PERIOD = 'month';

/** The quota sentence, derived from the column rather than typed. */
export function quotaLine(p: PlanCopyInput): string {
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
 *  Deliberately absent, for now: "Stem export". Migration 037 sets
 *  export_stems true on Studio and GET /api/jobs/[id]/download enforces it,
 *  but nothing in the UI calls that route yet, so a Studio buyer would have
 *  no way to find the feature the bullet promised. The bullet ships with the
 *  download button: when that lands, gate a "Stem export" bullet on
 *  p.export_stems here AND change "turning export flags on cannot add a
 *  bullet" in pricing-features-table.test.mjs in the same change. */
export function features(p: PlanCopyInput): string[] {
  const out: string[] = [];
  out.push(quotaLine(p));
  const named = p.services.map((s) => SERVICE_LABEL[s]).filter((l): l is string => !!l);
  if (named.length) out.push(`Link import: ${named.join(', ')}`);
  out.push('Loop download — 24-bit WAV');
  return out;
}
