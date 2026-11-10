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
              No ads, no tracking cookies. Loops are free and need no account; downloading the separated stems needs one. We
              delete your audio, stems, loops and job records after 24 hours. Account details stay until you delete the account.
            </p>

            <h2>What we process</h2>
            <ul>
              <li>
                <strong>Your audio.</strong> The file you upload, or the audio fetched from the YouTube link you paste, is processed
                to make stems and loops.
              </li>
              <li>
                <strong>Job details.</strong> The link or file name, the stems and loop length you chose, and the job’s progress.
              </li>
              <li>
                <strong>Your account, if you make one.</strong> An account is needed only to download the separated stems. We store
                your email address; your password is stored by Supabase as a hash, never in plain text, and we never see it. If you
                sign up after making jobs anonymously, you can attach those earlier jobs to your account so your history is
                continuous.
              </li>
              <li>
                <strong>A hashed IP address,</strong> used only for rate limiting. We store a keyed hash, not the IP itself.
              </li>
              <li>
                <strong>Error reports and server logs.</strong> When something breaks we record technical details (Sentry error
                reports, hosting logs). They are used only to fix problems.
              </li>
              <li>
                <strong>Your recent jobs.</strong> Your browser keeps a list of your recent job IDs (local storage plus a small
                signed cookie, both dropped after 24 hours) so the Job history page works. It is not used for anything else.
              </li>
            </ul>

            <h2>How long</h2>
            <p>Uploaded files, fetched audio, stems, loops and job records are deleted after 24 hours.</p>
            <p>
              Account details are the exception: they are not on that 24-hour clock, because an account has to outlive a job to be
              useful. They stay until you delete the account, which you can do yourself from your{' '}
              <a href="/account">account page</a> at any time, or by emailing us.
            </p>

            <h2>Who else handles it</h2>
            <ul>
              <li>Replicate runs the stem separation (Demucs).</li>
              <li>Cloudflare R2 stores files until they’re deleted.</li>
              <li>Fly.io runs the processing worker; Vercel hosts the website.</li>
              <li>Supabase hosts the job database and handles sign-in and password storage.</li>
              <li>Sentry receives error reports.</li>
              <li>YouTube downloads may go through a proxy provider.</li>
            </ul>
            <p>We don’t sell your data or share it for advertising.</p>

            <h2>Links to jobs</h2>
            <p>Anyone with a job’s link can open it until it is deleted, so don’t share links you want to keep private.</p>

            <h2>Contact</h2>
            <p>
              stem-loops is run by Jon Cartwright. Questions or deletion requests: email <a href={CONTACT_URL}>{CONTACT_LABEL}</a>. See also the{' '}
              <a href="/terms">terms</a>.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
