import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { CONTACT_EMAIL, LEGAL_UPDATED } from '@/components/landing/legal';

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
              No accounts, no ads, no tracking cookies. We keep your audio only long enough to make your loops, and delete files and
              jobs after 24 hours.
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
                <strong>A hashed IP address,</strong> used only for rate limiting. We store a keyed hash, not the IP itself.
              </li>
              <li>
                <strong>Error reports and server logs.</strong> When something breaks we record technical details (Sentry error
                reports, hosting logs). Cookies, IP addresses and job IDs are scrubbed from error reports.
              </li>
              <li>
                <strong>Your recent jobs.</strong> Your browser keeps a list of your recent job IDs (local storage plus a small
                signed cookie, kept up to 7 days) so the Job history page works. It is not used for anything else.
              </li>
            </ul>

            <h2>How long</h2>
            <p>Uploaded files, fetched audio, stems, loops and job records are deleted after 24 hours.</p>

            <h2>Who else handles it</h2>
            <ul>
              <li>Replicate runs the stem separation (Demucs).</li>
              <li>Cloudflare R2 stores files until they’re deleted.</li>
              <li>Fly.io runs the processing worker; Vercel hosts the website.</li>
              <li>Supabase hosts the job database.</li>
              <li>Sentry receives error reports.</li>
              <li>YouTube downloads may go through a proxy provider.</li>
            </ul>
            <p>We don’t sell your data or share it for advertising.</p>

            <h2>Links to jobs</h2>
            <p>Anyone with a job’s link can open it until it is deleted, so don’t share links you want to keep private.</p>

            <h2>Contact</h2>
            <p>
              Questions or deletion requests: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. See also the{' '}
              <a href="/terms">terms</a>.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
