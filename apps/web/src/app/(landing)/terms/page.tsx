import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { CONTACT_LABEL, CONTACT_URL, LEGAL_UPDATED } from '@/components/landing/legal';

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
              stem-loops splits a song into six stems and plays them back in your browser, with a fader, a mute and a solo on
              each, and an estimated chord track running above them. The same job also cuts bar-length loops you can download.
              Free to use at the moment. Paid plans and credits exist but are not required.
            </p>
            <p>
              You can start a job without an account. You need an account to open the player and reach your results. By using
              stem-loops you agree to these terms.
            </p>

            <h2>What it can and cannot do</h2>
            <ul>
              <li>Tracks up to 5 minutes. Longer tracks are refused when you submit them.</li>
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
                Splitting a song doesn’t change who owns it. stem-loops grants no rights in your audio, the stems, or the loops
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
              Two things outlive that. Your account stays until you delete it. And if a job charged a credit, or you saved a
              chord correction on it, a stripped-down record of that one job is kept so purchases and credits stay accounted
              for — what you asked for and when, with your file names, your links and your audio removed. Every other job is
              deleted outright.
            </p>

            <h2>No warranty</h2>
            <p>
              stem-loops is provided “as is”, without warranties of any kind. Results can be imperfect, and the service may be
              unavailable or change at any time. To the extent the law allows, we are not liable for any loss arising from using
              it.
            </p>

            <h2>Changes and contact</h2>
            <p>
              stem-loops is run by Jon Cartwright. We may update these terms; the date above shows the latest version. Questions,
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
