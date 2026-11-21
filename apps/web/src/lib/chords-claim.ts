// DB-17 (undecided; Jon, 2026-11-17: "wait and see"). THE one switch for every chord claim on
// the site. If new songs stop getting chords after 2026-12-05, the operator turns it off and, the
// same day, every PROMISE of a chord track leaves every public surface.
//
// RUNTIME SWITCH (A4, 2026-11-21). It used to be a build-time constant (`CHORDS_LINE_SHOWN`), so
// turning the claims off was a code change and a reviewed PR. It is now read from the server
// environment WHEN THE PAGE IS RENDERED, defaulting to ON:
//
//   CHORDS_CLAIMS=off   (also: false, 0, no; any case, surrounding spaces ignored)  -> claims OFF
//   unset, empty, or any other value                                              -> claims ON
//
// The default is ON because that is the state the site ships in today. Only an explicit "off"
// word turns the claims off, so a typo leaves the site as it is rather than silently changing it.
//
// Every surface that makes the claim calls `chordsLineShown()` while it renders, and every page
// that carries the claim is rendered per request (`dynamic = 'force-dynamic'`), so the value is
// read at request time, not frozen into a prerendered page at build time. Server-side only: a
// client component cannot read process.env (only NEXT_PUBLIC_* values are inlined), so the client
// components that make the claim (HomeDemo, LoopsView) receive the value as a prop from the
// server page that renders them.
//
// ON VERCEL an environment variable change applies to deployments made AFTER the change. So the
// operator sets CHORDS_CLAIMS=off and presses "Redeploy" on the current production deployment:
// no code change, no PR, no review. Clearing the variable (and redeploying) turns the claims back on.
//
// Surfaces that read it:
//   - home: the hero lead, the "What you get" Chords line (components/landing/what-you-get.ts),
//     the demo poster's note (components/landing/HomeDemo.tsx, via a prop), the home FAQ
//     (components/landing/faq.tsx), the Open Graph description, image and its alt text;
//   - /help (components/landing/faq.tsx): "What do I actually get?", "How good are the chords?"
//     (leaves the page), "Do I need an account?", "What happens to my files?";
//   - /terms (app/(landing)/terms/page.tsx): "The service", the length line, the estimate line;
//   - /privacy (app/(landing)/privacy/page.tsx): the short version and "Your audio";
//   - SEO: the meta descriptions for '/' and '/help' (lib/seo/pages.ts), the site-wide default
//     description (app/layout.tsx) and the Open Graph image every page shares (siteDescription,
//     ogImage, ogAlt and entityOneLiner in lib/seo/site.ts), the JSON-LD feature list
//     (lib/seo/jsonld.ts) and the /llms.txt body (lib/seo/llms.ts);
//   - the welcome email (lib/emails/templates/welcome.ts), read when the email is rendered;
//   - the loops page's "no steady beat" note (app/loops/LoopsView.tsx, via a prop).
//
// NOT switched, on purpose (DISCLOSURES, not promises): /privacy's processor list keeps
// "Klangio estimates the chords", and /privacy, /terms and /account/delete keep naming the
// chord data that already exists — the estimated chord track inside the 24-hour deletion, the
// chord-recognition reference numbers in a credit shell, and saved chord corrections. While any
// of that data exists the notice has to say so; over-disclosing is safe, under-disclosing is not.
//
// FLIP-DAY CHECKLIST (review SF-5), for the operator:
//   1. set CHORDS_CLAIMS=off in the Vercel production environment and redeploy;
//   2. clear CHORDS_PROVIDER on the worker (Fly secret) the same day, so no new audio goes to
//      Klangio once nothing promises chords; /privacy keeps naming Klangio while any chord data exists;
//   3. the /terms and /privacy "Last updated" dates are NOT moved by the switch (they cannot be:
//      it is not a code change). The OFF text of both pages is reviewed and pinned today by
//      test/chords-switch-surfaces.test.mjs, so what readers see on flip day is already reviewed.
//
// Gates: test/p7-copy.test.mjs renders the home page with CHORDS_CLAIMS=off; test/
// chords-switch-surfaces.test.mjs renders /help, /terms, /privacy, /llms.txt, the welcome email
// and the shared metadata with it off, pins the parser below, and scans src/ so that any file
// mentioning "chord" either reads this switch or sits on a reasoned allow-list.
//
// No imports, so lib/seo (loaded directly by node in tests) and components can both read it.

/** The environment variable that turns the chord claims off. Server-side only. */
export const CHORDS_CLAIMS_ENV = 'CHORDS_CLAIMS';

const OFF_WORDS = new Set(['off', 'false', '0', 'no']);

/** Pure parser for the variable's value: false only for an explicit "off" word. */
export function parseChordsClaims(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return true;
  return !OFF_WORDS.has(String(raw).trim().toLowerCase());
}

/**
 * True when the site may promise a chord track. Reads `process.env.CHORDS_CLAIMS` on every call
 * (never cached), so a server render reads the value of the running deployment.
 */
export function chordsLineShown(): boolean {
  // `typeof process` guards a client bundle; there the server value is passed down as a prop.
  return parseChordsClaims(typeof process === 'undefined' ? undefined : process.env[CHORDS_CLAIMS_ENV]);
}
