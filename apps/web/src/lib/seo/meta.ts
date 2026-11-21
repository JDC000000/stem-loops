// SEO-06. Every public page builds its metadata here. openGraph and twitter are COMPLETE objects:
// Next merges metadata shallowly, so a page that sets `openGraph` replaces the root one whole.
import type { Metadata } from 'next';
import { ogAlt, ogImage, SITE_NAME } from './site.ts';
import type { PublicPage } from './pages.ts';

export function pageMetadata(p: PublicPage): Metadata {
  // Read once per call, at request time on a dynamic page (lib/chords-claim.ts).
  const OG_IMAGE = ogImage();
  const OG_ALT = ogAlt();
  return {
    title: p.absoluteTitle ? { absolute: p.title } : p.title,
    description: p.description,
    alternates: { canonical: p.path },
    openGraph: {
      siteName: SITE_NAME, locale: 'en_CA', images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: OG_ALT }],
      title: p.title, description: p.description, url: p.path, type: p.section === 'guide' ? 'article' : 'website',
    },
    twitter: { card: 'summary_large_image', title: p.title, description: p.description, images: [{ url: OG_IMAGE, alt: OG_ALT }] },
    ...(p.published ? {} : { robots: { index: false, follow: false } }),
  };
}
