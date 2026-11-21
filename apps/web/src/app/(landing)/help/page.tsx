// /help (design v1.4, P7: "Home-page FAQ ≤ 5; the rest on a Help page"). Public, indexable,
// in the sitemap via the page registry (lib/seo/pages.ts). Every answer comes from
// components/landing/faq.tsx, the same source the home page's five are drawn from.
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo/meta';
import { pageFor } from '@/lib/seo/pages';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { FaqItem, helpSections } from '@/components/landing/faq';

// generateMetadata: the shared Open Graph image is a DB-17 chord claim (read at build: static page).
export function generateMetadata(): Metadata {
  return pageMetadata(pageFor('/help')!);
}

// STATIC and CDN-cached (PR #332, round 2): no `dynamic` export. The DB-17 chord switch
// (lib/chords-claim.ts) is read when the page is BUILT; a Vercel env change needs a Redeploy,
// which rebuilds this page with the new value.

export default function HelpPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="legal">
        <div className="container">
          <div className="reading">
            <h1>Help</h1>
            {helpSections().map((s) => (
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
