// SEO-04. The one list of public, indexable pages. Feeds sitemap.ts, llms.txt, jsonld.ts and the tests.
import { MAX_TRACK_MIN } from './site.ts';

export type PageSection = 'home' | 'product' | 'practice' | 'compare' | 'guide' | 'trust' | 'legal';
export type PublicPage = {
  path: string;          // '/', '/privacy'; no trailing slash except the root
  title: string;         // the <title> text; `absolute` when it already names stem-loops
  absoluteTitle?: boolean;
  description: string;   // ≤ 155 characters
  section: PageSection;
  lastModified: string;  // ISO date, edited by hand when the copy changes
  llms: boolean;         // listed in /llms.txt
  published: boolean;    // false: notFound() in production, noindex on previews, absent from sitemap/llms
};

export const PUBLIC_PAGES: PublicPage[] = [
  { path: '/', title: 'stem-loops: play along with any song, stem by stem', absoluteTitle: true,
    description: `Six stems with faders, mute and solo, a chord track and section loops. Play along in Chrome on the desktop. Uses the first ${MAX_TRACK_MIN} minutes of any song.`,
    section: 'home', lastModified: '2026-11-14', llms: true, published: true },
  { path: '/privacy', title: 'Privacy', description: 'What stem-loops stores, for how long, and who processes it.',
    section: 'legal', lastModified: '2026-11-13', llms: true, published: true },
  { path: '/terms', title: 'Terms', description: 'The short terms for using stem-loops.',
    section: 'legal', lastModified: '2026-11-14', llms: false, published: true },
];

export const publishedPages = () => PUBLIC_PAGES.filter((p) => p.published);
export const pageFor = (path: string) => PUBLIC_PAGES.find((p) => p.path === path);
