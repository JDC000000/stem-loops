// QA-55. The public demo-song pages, for sitemap.ts, llms.txt and /demo/<slug>'s metadata. Derived
// from DEMO_SONGS (lib/demo-catalog.ts), the list /demo/<slug> and the home page poster use; never a
// second list.
//
// Scope note (SEO-AIO-PLAN SEO-18): the plan, written before #302, describes ONE /demo page using
// only Lucky Ticket, as a registry entry. #302 shipped /demo/<slug> for the three catalog songs
// (DB-16 rights record), so all three are listed here instead of in PUBLIC_PAGES.
//
// Relative imports with .ts so node --experimental-strip-types can load this from a test.
import type { Metadata } from 'next';
import { DEMO_SONGS, demoBySlug, demoHref, type DemoSong } from '../demo-catalog.ts';
import { pageMetadata } from './meta.ts';
import type { PublicPage } from './pages.ts';

// Edited by hand when the demo pages change, like PublicPage.lastModified. Slice 2a (#302).
export const DEMO_PAGES_LAST_MODIFIED = '2026-11-18';

// A demo page in the registry's shape, so it goes through the SEO-06 builder like every public page.
// Title per SEO-AIO-PLAN §4.2 (/demo row): "Play along to …", ≤ 60 characters with the template suffix.
function demoPage(d: DemoSong): PublicPage {
  return {
    path: demoHref(d.slug),
    title: `Play along to ${d.title}`,
    description: `${d.title} by ${d.artist} in the stem-loops player, stem by stem. The demo opens without signing in.`,
    section: 'product',
    lastModified: DEMO_PAGES_LAST_MODIFIED,
    llms: true,
    published: true,
  };
}

export const demoPages = (): PublicPage[] => DEMO_SONGS.map(demoPage);

/** Metadata for /demo/<slug>: the SEO-06 builder for a catalog slug; noindex for anything else. */
export function demoMetadata(slug: string): Metadata {
  const song = demoBySlug(slug);
  if (!song) return { title: 'Play along: demo song', robots: { index: false, follow: false } };
  return pageMetadata(demoPage(song));
}
