// DB-17 (undecided; Jon, 2026-11-17: "wait and see"). THE one switch for every chords claim on
// the home page. If new songs stop getting chords after 2026-12-05, set this to false and, the
// same day, every chord claim leaves the home page:
//   - the "What you get" Chords line (components/landing/what-you-get.ts);
//   - the hero lead, the player section's paragraph, the drawn player's Chords band and its
//     caption, and the pipeline's "Length used", "Play" and <dt>Chords</dt> rows
//     (app/(landing)/page.tsx, components/landing/PlayerArt.tsx);
//   - the home FAQ's "How good are the chords?" and the chord track in "Do I need an account?"
//     (components/landing/faq.tsx);
//   - the Open Graph description, the meta description for '/' (lib/seo/pages.ts), and the JSON-LD
//     feature list and description (lib/seo/jsonld.ts, ENTITY_ONE_LINER in lib/seo/site.ts).
// test/p7-copy.test.mjs renders the home page with this set to false and fails on any "chord"
// left in its text, attributes, metadata or JSON-LD.
//
// NOT covered by the switch (named residue): the Open Graph IMAGE (/og-image-v4.png) draws chord
// names, and OG_ALT describes that image truthfully. Swapping the image is an asset change.
// /help keeps its chords answer; it is not the home page.
//
// No imports, so lib/seo (loaded directly by node in tests) and components can both read it.
export const CHORDS_LINE_SHOWN = true;
