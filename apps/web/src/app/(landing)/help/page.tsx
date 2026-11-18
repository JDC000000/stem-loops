// /help (design v1.4, P7: "Home-page FAQ ≤ 5; the rest on a Help page"). Public, indexable,
// in the sitemap via the page registry (lib/seo/pages.ts). Every answer comes from
// components/landing/faq.tsx, the same source the home page's five are drawn from.
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo/meta';
import { pageFor } from '@/lib/seo/pages';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { FaqItem, HELP_SECTIONS } from '@/components/landing/faq';

export const metadata: Metadata = pageMetadata(pageFor('/help')!);

export default function HelpPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="legal">
        <div className="container">
          <div className="reading">
            <h1>Help</h1>
            {HELP_SECTIONS.map((s) => (
              <section key={s.heading} aria-label={s.heading}>
                <h2>{s.heading}</h2>
                <div className="faq">
                  {s.entries.map((e) => (
                    <FaqItem key={e.id} entry={e} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
