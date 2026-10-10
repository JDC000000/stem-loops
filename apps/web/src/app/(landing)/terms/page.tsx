import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { CONTACT_EMAIL, LEGAL_UPDATED } from '@/components/landing/legal';

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
              stem-loops splits audio you give it into stems and cuts them into loops. It is free and there are no accounts. By
              using it you agree to these terms.
            </p>

            <h2>Your audio, your responsibility</h2>
            <ul>
              <li>Only upload or link audio you own or have the rights to use this way.</li>
              <li>
                When you paste a YouTube link, we fetch the audio on your behalf. You are responsible for following YouTube’s terms
                and copyright law.
              </li>
              <li>
                Splitting a song doesn’t change who owns it. stem-loops grants no rights in your audio or the loops made from it, and
                can’t clear samples for you.
              </li>
            </ul>

            <h2>Fair use of the service</h2>
            <p>
              Don’t abuse it: no automated bulk use, no attempts to get around the rate limits, and nothing illegal. We may limit or
              block use that harms the service or other people.
            </p>

            <h2>Deletion</h2>
            <p>Your files, loops and jobs are deleted after 24 hours. Download what you want to keep.</p>

            <h2>No warranty</h2>
            <p>
              stem-loops is provided “as is”, without warranties of any kind. Results can be imperfect (tempo, bar positions and
              separation quality vary), and the service may be unavailable or change at any time. To the extent the law allows, we
              are not liable for any loss arising from using it.
            </p>

            <h2>Changes and contact</h2>
            <p>
              We may update these terms; the date above shows the latest version. Questions:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. See also the <a href="/privacy">privacy notice</a>.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
