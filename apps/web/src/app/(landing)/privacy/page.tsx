import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo/meta';
import { pageFor } from '@/lib/seo/pages';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { CONTACT_LABEL, CONTACT_URL, PRIVACY_UPDATED } from '@/components/landing/legal';
import { CHORDS_LINE_SHOWN } from '@/lib/chords-claim';

// DB-17 (lib/chords-claim.ts). With the switch off, only the PROMISE goes: the short version and
// "Your audio" stop describing chord estimation as what happens to a new song. Every DISCLOSURE
// stays, word for word, whatever the switch says: Klangio in "Who else handles it", the estimated
// chord track in the 24-hour deletion, the chord-recognition reference numbers in a credit shell,
// and saved chord corrections. That data exists while any song has chords, and a processor that
// has received audio must stay listed. test/chords-switch-surfaces.test.mjs pins both halves.

// SEO-06: registry-driven, so the page gets canonical, Open Graph and Twitter tags.
export const metadata: Metadata = pageMetadata(pageFor('/privacy')!);

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="legal">
        <div className="container">
          <div className="reading">
            <h1>Privacy</h1>
            <p className="updated">Last updated {PRIVACY_UPDATED}</p>

            <h2>The short version</h2>
            <p>
              No ads, no tracking cookies, nothing sold. You can start a job without an account, but you need one to open the
              player with your own songs and reach your results. The demo songs open without signing in.{' '}
              {CHORDS_LINE_SHOWN
                ? 'Your audio goes to two outside services to be processed — one to split it into stems, one to estimate the chords — and both are named below.'
                : 'Your audio goes to outside services to be processed, and every one of them is named below.'}{' '}
              {/* Source of truth: 24 hours = RETENTION_HOURS, 30 days = PAID_RETENTION_GRACE_DAYS, 7 days =
                  the past_due interval in JOB_RETAINED_UNTIL_SQL (lib/retention.ts; migration 007). Pinned by
                  test/chords-switch-surfaces.test.mjs. */}
              On the Free plan we delete your audio, stems, loops
              and job records after 24 hours. On Pro and Studio they stay in your library while you are subscribed, and for
              30 days after your plan ends. Account details stay until you delete the account.
            </p>

            <h2>What we process</h2>
            <ul>
              <li>
                <strong>Your audio.</strong> The file you upload, or the audio fetched from the YouTube link you paste. It is
                sent to the processors named below to be separated into stems
                {CHORDS_LINE_SHOWN ? ' and to have its chords estimated.' : '.'}
              </li>
              <li>
                <strong>Job details.</strong> The link or file name, the song’s title (the video’s title on YouTube, or the file name without its extension), the stems and loop length you chose, and the job’s progress.
              </li>
              <li>
                <strong>Your account.</strong> We store your email address. If you set a password, it is stored by Supabase as a
                hash, never in plain text, and we never see it. If you sign in with Google, Google tells us your email address
                and basic profile; we never see your Google password.
              </li>
              <li>
                <strong>A hashed IP address,</strong> used only to rate-limit. We store a keyed hash, not the IP itself.
              </li>
              <li>
                <strong>Error reports and server logs.</strong> When something breaks we record technical details. They are used
                only to fix problems.
              </li>
              <li>
                <strong>Your recent jobs.</strong> Your browser keeps a list of your recent job IDs (local storage plus a small
                signed cookie; each job id is dropped once its job is deleted, and the cookie expires 24 hours after your last job) so the Library page works. It is not used for anything else.
              </li>
            </ul>

            <h2>How long</h2>
            <p>
              Uploaded files, fetched audio, stems, loops, the estimated chord track and the job’s own row are
              deleted after 24 hours.
            </p>
            <p>
              That is the Free plan, and every job started without an account. On Pro and Studio, the songs in your account
              are kept instead, as your library: while your subscription is active (including up to 7 days while a failed
              renewal payment is retried), and for 30 days after it ends. Then they are deleted the same way. A song you
              start after your plan has ended is deleted after 24 hours.
            </p>
            <p>
              Account details are not on that clock, because an account has to outlive a job to be useful. They stay until you
              delete the account, which you can do yourself from your <a href="/account">account page</a> at any time, or by
              emailing us.
            </p>
            <p>Three other things outlive those times:</p>
            <ul>
              <li>
                <strong>A shell of a job that charged a credit,</strong> kept so purchases and credits stay accounted for. It
                holds the job’s id, status, timestamps and expiry, which account it belonged to, whether it was an upload or
                a link, the stems and loop length you chose, the progress trace, how many attempts it took and any error it
                ended with, and the reference numbers for the separation and chord-recognition runs — including the one held
                by Klangio. Your file names, song titles, links and audio are gone from it.
              </li>
              <li>
                <strong>Chord corrections you save,</strong> kept to improve the chord estimates: the part of the song a
                correction covers, what we estimated, what you changed it to, and a one-way fingerprint of the audio. These are
                not on that clock — they stay until you delete your account. Nothing in the player sends them today.
              </li>
              <li>
                <strong>Counters and diagnostics,</strong> kept without a time limit: that a job was started, that a payment
                was attempted or refunded (with the payment provider’s reference numbers), that an account was deleted, and how
                an attempt to fetch audio went. They hold no audio, no file names and no links — a YouTube fetch is
                recorded against a one-way hash of the video id, never the address you pasted.
              </li>
            </ul>
            <p>Deleting your account removes your account details and your chord corrections.</p>

            <h2>Who else handles it</h2>
            <p>These are everyone who touches your audio or your account, and what each one does:</p>
            <ul>
              <li>
                <strong>Replicate</strong> runs the stem separation. Your audio is sent to them.
              </li>
              <li>
                <strong>Klangio</strong> estimates the chords. Your audio is sent to them too.
              </li>
              <li>
                <strong>Cloudflare R2</strong> stores your files until they are deleted.
              </li>
              <li>
                <strong>Fly.io</strong> runs the processing worker; <strong>Vercel</strong> hosts the website.
              </li>
              <li>
                <strong>Supabase</strong> hosts the job database and handles sign-in and password storage.
              </li>
              <li>
                <strong>Google</strong>, only if you choose to sign in with it, confirms who you are and gives us your email
                address.
              </li>
              <li>
                <strong>hCaptcha</strong> checks that a new sign-up is a person rather than a bot.
              </li>
              <li>
                <strong>Stripe</strong> handles payment if you ever buy a plan or a credit pack. They receive your email
                address. We never see or store your card number.
              </li>
              <li>
                <strong>Resend</strong> sends account and receipt emails, so it receives your email address.
              </li>
              <li>
                <strong>Sentry</strong> receives error reports.
              </li>
              {/* 2A: lib/analytics.ts (no cookies; URLs sent without query string; event props are a closed
                  non-personal list). Pinned by test/legal-privacy-copy.test.mjs. */}
              <li>
                <strong>Vercel Web Analytics</strong> counts visits and page views, and a few actions such as playing a
                demo song. It is anonymous and uses no cookies.
              </li>
              <li>A proxy provider may be used to fetch audio from YouTube links.</li>
              <li>
                <strong>YouTube</strong> serves the small picture shown next to a linked song in your library. Your
                browser asks YouTube for it directly, without telling YouTube which page it is on, so YouTube sees your IP
                address and that video’s id.
              </li>
            </ul>
            <p>We don’t sell your data or share it for advertising.</p>

            <h2>Links to jobs</h2>
            <p>
              A job you start without an account is protected only by its link: anyone holding the link can fetch its audio
              and stems, with no account at all, until the job is deleted. So don’t share a link you want to keep private.
            </p>
            <p>
              A job you start while signed in can be opened only by your account. For anyone else, its link behaves as if
              the job did not exist. The file links we hand out for a job last up to 24 hours and cannot be recalled once
              issued, so a file link that someone already has keeps working until it expires.
            </p>

            <h2>Contact</h2>
            <p>
              Jon Cartwright runs stem-loops. Questions or deletion requests: email{' '}
              <a href={CONTACT_URL}>{CONTACT_LABEL}</a>. See also the <a href="/terms">terms</a>.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
