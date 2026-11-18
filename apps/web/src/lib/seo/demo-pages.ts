// QA-55. The public demo-song pages, for sitemap.ts and llms.txt. Derived from DEMO_SONGS
// (lib/demo-catalog.ts), the list /demo/<slug> and the home page poster use; never a second list.
// Relative imports with .ts so node --experimental-strip-types can load this from a test.
import { DEMO_SONGS, demoHref } from '../demo-catalog.ts';

// Edited by hand when the demo pages change, like PublicPage.lastModified. Slice 2a (#302).
export const DEMO_PAGES_LAST_MODIFIED = '2026-11-18';

export type DemoPage = { path: string; title: string; description: string; lastModified: string };

export const demoPages = (): DemoPage[] =>
  DEMO_SONGS.map((d) => ({
    path: demoHref(d.slug),
    title: `${d.title} by ${d.artist}`,
    description: `${d.title}, a song by ${d.artist}, open in the player. The demo opens without signing in.`,
    lastModified: DEMO_PAGES_LAST_MODIFIED,
  }));
