import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo/meta';
import { pageFor } from '@/lib/seo/pages';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { CONTACT_LABEL, CONTACT_URL, formatDay, termsUpdatedOn } from '@/components/landing/legal';
import { MAX_TRACK_SEC } from '@/lib/play/types';
import { chordsLineShown } from '@/lib/chords-claim';
import { isCheckoutEnabled } from '@/lib/billing/checkout-switch';

// Read from the one ceiling, exactly as the landing page does, rather than typed as a word.
// A legal page is the worst place to carry a number that a single env change can falsify, and
// MAX_UPLOAD_DURATION_SEC can be retuned on the worker without touching any of this code.
// Deriving it means the figure here can only ever be wrong together with the figure the
// player enforces -- and test/legal-terms-copy.test.mjs compares the rendered figure to this
// constant and to the worker's own default, so a drift between the three fails there.
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

// C-17 (QA 2026-11-18); B-8w (2026-11-25). NO NUMBER for the Free monthly limit on this page.
// Source of truth: plans.monthly_job_quota for 'free' (seeded 5 by
// apps/worker/migrations/034_v3_pricing_model_truth.sql), enforced for accounts by
// checkMonthlyQuota() / enforceEntitlement() (lib/billing/entitlements.ts) and, for links, by
// bumpJobsUsedWithinQuota() in app/api/jobs/route.ts. /pricing reads that row at request time.
// For the beta Jon changes the row in the DB (30 from 2026-11-30, back on 2026-12-14) with no
// code change, so a number typed here would be false for two weeks. The sentence below points at
// /pricing instead; test/legal-terms-copy.test.mjs pins that no "<n> songs a month" figure
// appears on this page.
//
// Credits are for UPLOADED files only: the credit_consumption trigger (migration 013) accepts
// upload jobs only, and a Free account holding credits is still capped at the free monthly limit
// for links (app/api/jobs/route.ts, link branch). Hence "credits for uploaded files" below (QA
// follow-up SF-3).
//
// BILLING_ENFORCED SWITCH-ON CHECKLIST (QA follow-up SF-4; the flag lives in lib/billing/entitlements.ts,
// a CODEOWNERS path this change does not touch). Today BILLING_ENFORCED is off, and a Free
// account's UPLOADS fall back to this monthly allowance, so "a monthly number of songs" is true
// for uploads and links alike. With BILLING_ENFORCED=true a Free upload with no credits is refused
// (CREDIT_BALANCE_INSUFFICIENT) and the allowance covers LINKS only. On the day the flag goes on,
// in the same change: reword the Free sentence below (e.g. "covers a monthly number of song links;
// uploads use credits"), bump TERMS_UPDATED_ON (components/landing/legal.ts), and re-check /pricing
// and /help.

// SEO-06: registry-driven, so the page gets canonical, Open Graph and Twitter tags.
// generateMetadata: the shared Open Graph image is a DB-17 chord claim (read at build: static page).
export function generateMetadata(): Metadata {
  return pageMetadata(pageFor('/terms')!);
}

// STATIC and CDN-cached (PR #332, round 2): no `dynamic` export. The DB-17 chord switch
// (lib/chords-claim.ts) is read when the page is BUILT; a Vercel env change needs a Redeploy,
// which rebuilds this page with the new value.

export default function TermsPage() {
  const chords = chordsLineShown(); // DB-17, read at build (the page is static)
  const checkout = isCheckoutEnabled(); // QP-3 (#455), read at build (the page is static)
  return (
    <>
      <SiteHeader />
      <main id="main" className="legal">
        <div className="container">
          <div className="reading">
            <h1>Terms</h1>
            <p className="updated">Last updated {formatDay(termsUpdatedOn())}</p>

            <h2>The service</h2>
            <p>
              We split a song into six stems and play them back in your browser, with a fader, a mute and a solo on
              {/* DB-17 (lib/chords-claim.ts): no chord claim when the switch is off. */}
              {chords ? ' each, and an estimated chord track running above them.' : ' each.'} The same job also
              finds bar-length loops you can cut and download.
            </p>
            <p>
              {/* B-8w: no number here; see the C-17 note at the top of this file. */}
              The Free plan costs nothing and covers a monthly number of songs on your account: the limit shown on
              the <a href="/pricing">pricing page</a>, which we may change.
              {/* QP-3: while checkout is hidden in the beta (lib/billing/checkout-switch.ts, #455) nothing
                  can be bought, so the page says so, in #470's words. Read at build, like the chords switch. */}
              {checkout
                ? ' For more than that you need a paid plan (Pro or Studio), or credits for uploaded files (credits do not add song links). Prices are on the same page.'
                : ' Paid plans (Pro or Studio) and credits for uploaded files (credits do not add song links) cover more than that, but they aren’t on sale during the beta. Prices are on the same page.'}
            </p>
            <p>
              You can start a job from an uploaded file without an account; a song link added on the home page asks you to
              sign in first. You need an account to open the player with your own songs and reach your results. The demo songs open without signing in. By using stem-loops you agree to these terms.
            </p>

            <h2>What it can and cannot do</h2>
            <ul>
              <li>
                We use the first {MAX_TRACK_MIN}&nbsp;minutes of any song. A longer track is trimmed on our end to its
                first {MAX_TRACK_MIN}&nbsp;minutes, which is where{' '}
                {chords ? 'the chord track and the player both stop.' : 'the player stops.'}
              </li>
              <li>
                Built for your phone and your computer, and tested in Chrome. On a phone the player loads lighter audio so
                all six stems fit in memory. Other browsers are not tested yet.
              </li>
              {chords && (
                <li>
                  The chords are an <strong>estimate made from the audio</strong>, not a transcription anyone checked. Trust your
                  ears over the screen.
                </li>
              )}
              <li>
                Separation is imperfect. Dense passages can leave bleed from other instruments in a stem, and tempo and bar
                positions vary.
              </li>
            </ul>

            <h2>Your audio, your responsibility</h2>
            <ul>
              <li>Only upload or link audio you own or have the rights to use this way.</li>
              <li>
                When you paste a YouTube link, we fetch the audio on your behalf. You are responsible for following YouTube’s
                terms and copyright law.
              </li>
              <li>
                Splitting a song doesn’t change who owns it. We grant no rights in your audio, the stems, or the loops
                made from it, and can’t clear samples for you.
              </li>
            </ul>

            <h2>Fair use of the service</h2>
            <p>
              Don’t abuse it: no automated bulk use, no attempts to get around the rate limits, and nothing illegal. We may limit
              or block use that harms the service or other people.
            </p>

            <h2>Deletion</h2>
            {/* Source of truth: 24 hours = RETENTION_HOURS, 30 days = PAID_RETENTION_GRACE_DAYS (lib/retention.ts;
                jobs.expires_at default, migration 007). Pinned by test/chords-switch-surfaces.test.mjs. The
                "chord corrections" line below is a DISCLOSURE of data that exists, so DB-17 leaves it on. */}
            <p>
              Your files, stems, loops and job details are deleted after 24 hours — download what you want to keep.
            </p>
            <p>
              That is the Free plan, and every job started without an account. On Pro and Studio, the songs in your account
              are kept as your library while your subscription is active, and for 30 days after it ends; then they are
              deleted the same way. A song you start after your plan has ended is deleted after 24 hours.
            </p>
            <p>
              Some things outlive that: your account, until you delete it; your song library’s record of each song you
              started while signed in (its link or file name, title, BPM and key, never its audio) and your set lists,
              until you remove them or delete your account; a stripped-down shell of any job that charged a
              credit, so purchases stay accounted for; any chord corrections you saved, which are kept until you delete your
              account; and counters and diagnostics that hold no audio, file names or links. The{' '}
              <a href="/privacy">privacy notice</a> sets out exactly what each of those keeps. Every other job is deleted
              outright.
            </p>

            <h2>No warranty</h2>
            <p>
              We provide stem-loops “as is”, without warranties of any kind. Results can be imperfect, and the service may be
              unavailable or change at any time. To the extent the law allows, we are not liable for any loss arising from using
              it.
            </p>

            <h2>Changes and contact</h2>
            <p>
              Jon Cartwright runs stem-loops. We may update these terms; the date above shows the latest version. Questions,
              or a copyright complaint about content on the service: email <a href={CONTACT_URL}>{CONTACT_LABEL}</a>. See also
              the <a href="/privacy">privacy notice</a>.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
