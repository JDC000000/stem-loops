// SEO-06. Every public page builds its metadata here. openGraph and twitter are COMPLETE objects:
// Next merges metadata shallowly, so a page that sets `openGraph` replaces the root one whole.
import type { Metadata } from 'next';
import { OG_IMAGE, SITE_NAME } from './site.ts';
import type { PublicPage } from './pages.ts';

export function pageMetadata(p: PublicPage): Metadata {
  return {
    title: p.absoluteTitle ? { absolute: p.title } : p.title,
    description: p.description,
    alternates: { canonical: p.path },
    openGraph: {
      siteName: SITE_NAME, locale: 'en_CA', images: [{ url: OG_IMAGE, width: 1200, height: 630 }],
      title: p.title, description: p.description, url: p.path, type: p.section === 'guide' ? 'article' : 'website',
    },
    twitter: { card: 'summary_large_image', title: p.title, description: p.description, images: [OG_IMAGE] },
    ...(p.published ? {} : { robots: { index: false, follow: false } }),
  };
}
