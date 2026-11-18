// DB-17 (undecided; Jon, 2026-11-17: "wait and see"). THE one switch for every chord claim on
// the site. If new songs stop getting chords after 2026-12-05, set this to false and, the same
// day, every PROMISE of a chord track leaves every public surface:
//   - home: the "What you get" Chords line (components/landing/what-you-get.ts); the hero lead,
//     the player section's paragraph, the drawn player's Chords band and its caption, and the
//     pipeline's "Length used", "Play" and <dt>Chords</dt> rows (app/(landing)/page.tsx,
//     components/landing/PlayerArt.tsx); the Open Graph description, image and its alt text;
//   - FAQ, home and /help (components/landing/faq.tsx): "What do I actually get?", "How good are
//     the chords?" (leaves both pages), "Do I need an account?", "What happens to my files?";
//   - /terms (app/(landing)/terms/page.tsx): "The service", the length line, the estimate line;
//   - /privacy (app/(landing)/privacy/page.tsx): the short version and "Your audio";
//   - SEO: the meta descriptions for '/' and '/help' (lib/seo/pages.ts), the site-wide default
//     description and the Open Graph image every page shares (SITE_DESCRIPTION, OG_IMAGE and
//     ENTITY_ONE_LINER in lib/seo/site.ts), the JSON-LD feature list (lib/seo/jsonld.ts) and the
//     /llms.txt body (lib/seo/llms.ts);
//   - the welcome email (lib/emails/templates/welcome.ts);
//   - the loops page's "no steady beat" note (app/loops/LoopsView.tsx).
//
// NOT switched, on purpose (DISCLOSURES, not promises): /privacy's processor list keeps
// "Klangio estimates the chords", and /privacy, /terms and /account/delete keep naming the
// chord data that already exists — the estimated chord track inside the 24-hour deletion, the
// chord-recognition reference numbers in a credit shell, and saved chord corrections. While any
// of that data exists the notice has to say so; over-disclosing is safe, under-disclosing is not.
//
// Gates: test/p7-copy.test.mjs renders the home page with this set to false; test/
// chords-switch-surfaces.test.mjs renders /help, /terms, /privacy, /llms.txt, the welcome email
// and the shared metadata with it false, and scans src/ so that any file mentioning "chord"
// either imports this switch or sits on a reasoned allow-list.
//
// No imports, so lib/seo (loaded directly by node in tests) and components can both read it.
export const CHORDS_LINE_SHOWN = true;
