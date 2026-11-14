import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { CONTACT_LABEL, CONTACT_URL, LEGAL_UPDATED } from '@/components/landing/legal';
import { MAX_TRACK_SEC } from '@/lib/play/types';

// Read from the one ceiling, exactly as the landing page does, rather than typed as a word.
// A legal page is the worst place to carry a number that a single env change can falsify, and
// MAX_UPLOAD_DURATION_SEC can be retuned on the worker without touching any of this code.
// Deriving it means the figure here can only ever be wrong together with the figure the
// player enforces -- and test/legal-terms-copy.test.mjs compares the rendered figure to this
// constant and to the worker's own default, so a drift between the three fails there.
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

export const metadata: Metadata = {
  title: 'Terms',
  description: 'The short terms for using stem-loops.',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="legal">
        <div className="container">
          <div className="reading">
            <h1>Terms</h1>
            <p className="updated">Last updated {LEGAL_UPDATED}</p>

            <h2>The service</h2>
            <p>
              We split a song into six stems and play them back in your browser, with a fader, a mute and a solo on
              each, and an estimated chord track running above them. The same job also finds bar-length loops you can cut and download.
              Free to use at the moment. Paid plans and credits exist but are not required.
            </p>
            <p>
              You can start a job without an account. You need an account to open the player and reach your results. By using
              stem-loops you agree to these terms.
            </p>

            <h2>What it can and cannot do</h2>
            <ul>
              <li>
                We use the first {MAX_TRACK_MIN}&nbsp;minutes of any song. A longer track is trimmed on our end to its
                first {MAX_TRACK_MIN}&nbsp;minutes, which is where the chord track and the player both stop.
              </li>
              <li>Chrome, on a desktop or laptop. Other browsers and phones are not supported yet.</li>
              <li>
                The chords are an <strong>estimate made from the audio</strong>, not a transcription anyone checked. Trust your
                ears over the screen.
              </li>
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
            <p>
              Your files, stems, loops and job details are deleted after 24 hours — download what you want to keep.
            </p>
            <p>
              Some things outlive that: your account, until you delete it; a stripped-down shell of any job that charged a
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
