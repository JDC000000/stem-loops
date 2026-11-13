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
                <strong>A hashed IP address,</strong> used only to rate-limit. We store a keyed hash, not the IP itself.
              </li>
              <li>
                <strong>Error reports and server logs.</strong> When something breaks we record technical details. They are used
                only to fix problems.
              </li>
              <li>
                <strong>Your recent jobs.</strong> Your browser keeps a list of your recent job IDs (local storage plus a small
                signed cookie; each job id is dropped once its job is deleted, and the cookie expires 24 hours after your last job) so the Job history page works. It is not used for anything else.
              </li>
            </ul>

            <h2>How long</h2>
            <p>Uploaded files, fetched audio, stems, loops and the job’s own row are deleted after 24 hours.</p>
            <p>
              Account details are not on that clock, because an account has to outlive a job to be useful. They stay until you
              delete the account, which you can do yourself from your <a href="/account">account page</a> at any time, or by
              emailing us.
            </p>
            <p>Three other things outlive the 24 hours:</p>
            <ul>
              <li>
                <strong>A shell of a job that charged a credit,</strong> kept so purchases and credits stay accounted for. It
                holds the job’s id, status, timestamps and expiry, which account it belonged to, whether it was an upload or
                a link, the stems and loop length you chose, the progress trace, how many attempts it took and any error it
                ended with, and the reference numbers for the separation and chord-recognition runs — including the one held
                by Klangio. Your file names, your links and your audio are gone from it.
              </li>
              <li>
                <strong>Chord corrections you save,</strong> kept to improve the chord estimates: the part of the song a
                correction covers, what we estimated, what you changed it to, and a one-way fingerprint of the audio. These are
                not on the 24-hour clock — they stay until you delete your account. Nothing in the player sends them today.
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
                <strong>Resend</strong> sends account and receipt emails, so it receives your email address.
              </li>
              <li>
                <strong>Sentry</strong> receives error reports.
              </li>
              <li>A proxy provider may be used to fetch audio from YouTube links.</li>
            </ul>
            <p>We don’t sell your data or share it for advertising.</p>

            <h2>Links to jobs</h2>
            <p>
              A job’s link is the only thing protecting it. The player page asks you to sign in, but that gate is on the page
              alone — the job’s audio and stems can be fetched by anyone holding the link, with no account at all, until the
              job is deleted. So don’t share a link you want to keep private.
            </p>

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
