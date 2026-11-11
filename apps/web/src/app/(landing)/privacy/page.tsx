import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { CONTACT_LABEL, CONTACT_URL, LEGAL_UPDATED } from '@/components/landing/legal';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What stem-loops stores, for how long, and who processes it.',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="legal">
        <div className="container">
          <div className="reading">
            <h1>Privacy</h1>
            <p className="updated">Last updated {LEGAL_UPDATED}</p>

            <h2>The short version</h2>
            <p>
              No ads, no tracking cookies, nothing sold. You can start a job without an account, but you need one to open the
              player and reach your results. Your audio goes to two outside services to be processed — one to split it into
              stems, one to estimate the chords — and both are named below. We delete your audio, stems, loops and job records
              after 24 hours. Account details stay until you delete the account.
            </p>

            <h2>What we process</h2>
            <ul>
              <li>
                <strong>Your audio.</strong> The file you upload, or the audio fetched from the YouTube link you paste. It is
                sent to the processors named below to be separated into stems and to have its chords estimated.
              </li>
              <li>
                <strong>Job details.</strong> The link or file name, the stems and loop length you chose, and the job’s progress.
              </li>
              <li>
                <strong>Your account.</strong> We store your email address. If you set a password, it is stored by Supabase as a
                hash, never in plain text, and we never see it. If you sign in with Google, Google tells us your email address
                and basic profile; we never see your Google password.
              </li>
              <li>
                <strong>A hashed IP address,</strong> used only for rate limiting. We store a keyed hash, not the IP itself.
              </li>
              <li>
                <strong>Error reports and server logs.</strong> When something breaks we record technical details. They are used
                only to fix problems.
              </li>
              <li>
                <strong>Your recent jobs.</strong> Your browser keeps a list of your recent job IDs (local storage plus a small
                signed cookie, both dropped after 24 hours) so the Job history page works. It is not used for anything else.
              </li>
            </ul>

            <h2>How long</h2>
            <p>Uploaded files, fetched audio, stems, loops and job records are deleted after 24 hours.</p>
            <p>
              Two things are the exception. Account details are not on that 24-hour clock, because an account has to outlive a
              job to be useful; they stay until you delete the account, which you can do yourself from your{' '}
              <a href="/account">account page</a> at any time, or by emailing us.
            </p>
            <p>
              The second applies only to a job that charged a credit, or that you saved a chord correction on. A stripped-down
              record of that job is kept so purchases and credits stay accounted for. It holds the job’s id, status and
              timestamps, which account it belonged to, the stems and loop length you chose, the progress trace, and an
              internal reference to the separation run. Your file names, your links, your audio and what we estimated from it
              are removed. Every other job is deleted outright.
            </p>

            <h2>Who else handles it</h2>
            <p>These are everyone who touches your audio or your account, and what each one does:</p>
            <ul>
              <li>
                <strong>Replicate</strong> runs the stem separation (Demucs). Your audio is sent to them.
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
                <strong>Sentry</strong> receives error reports.
              </li>
              <li>A proxy provider may be used to fetch audio from YouTube links.</li>
            </ul>
            <p>We don’t sell your data or share it for advertising.</p>

            <h2>Links to jobs</h2>
            <p>Anyone with a job’s link and an account can open it until it is deleted, so don’t share links you want to keep private.</p>

            <h2>Contact</h2>
            <p>
              stem-loops is run by Jon Cartwright. Questions or deletion requests: email{' '}
              <a href={CONTACT_URL}>{CONTACT_LABEL}</a>. See also the <a href="/terms">terms</a>.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
