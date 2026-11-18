// SEO-04. The one list of public, indexable pages. Feeds sitemap.ts, llms.txt, jsonld.ts and the tests.
import { MAX_TRACK_MIN } from './site.ts';
import { CHORDS_LINE_SHOWN } from '../chords-claim.ts';

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
    // DB-17 (lib/chords-claim.ts): no chord claim when the switch is off.
    description: CHORDS_LINE_SHOWN
      ? `Six stems with faders, mute and solo, a chord track and section loops. Play along on a computer or a phone. Uses the first ${MAX_TRACK_MIN} minutes of any song.`
      : `Six stems with faders, mute and solo, and section loops. Play along on a computer or a phone. Uses the first ${MAX_TRACK_MIN} minutes of any song.`,
    section: 'home', lastModified: '2026-11-18', llms: true, published: true },
  { path: '/loops', title: 'Download loops',
    description: 'Bar-length loops cut from each stem of a song you have split, as 24-bit WAV files named by stem, BPM, key, section and number.',
    section: 'product', lastModified: '2026-11-15', llms: true, published: true },
  { path: '/pricing', title: 'Pricing',
    description: 'Free, Pro and Studio plans in Canadian dollars: how many songs you can add each month, how long they are kept, and one-time credit packs.',
    section: 'product', lastModified: '2026-11-17', llms: true, published: true },
  { path: '/help', title: 'Help',
    // DB-17: the chords question leaves /help with the switch off, so the description drops it too.
    description: CHORDS_LINE_SHOWN
      ? 'Answers about accounts, browsers and phones, the chords, how long a song takes, song links, and what happens to your files.'
      : 'Answers about accounts, browsers and phones, how long a song takes, song links, and what happens to your files.',
    section: 'trust', lastModified: '2026-11-18', llms: true, published: true },
  { path: '/privacy', title: 'Privacy', description: 'What stem-loops stores, for how long, and who processes it.',
    section: 'legal', lastModified: '2026-11-17', llms: true, published: true },
  { path: '/terms', title: 'Terms', description: 'The short terms for using stem-loops.',
    section: 'legal', lastModified: '2026-11-18', llms: false, published: true },
];

export const publishedPages = () => PUBLIC_PAGES.filter((p) => p.published);
export const pageFor = (path: string) => PUBLIC_PAGES.find((p) => p.path === path);
