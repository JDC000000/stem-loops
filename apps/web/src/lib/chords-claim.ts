// DB-17 (undecided; Jon, 2026-11-17: "wait and see"). THE one switch for every chord claim on
// the site. If new songs stop getting chords after 2026-12-05, the operator turns it off and, the
// same day, every PROMISE of a chord track leaves every public surface.
//
// AN ENV SWITCH, NOT A CODE CHANGE (A4, 2026-11-21). It used to be a build-time constant
// (`CHORDS_LINE_SHOWN`), so turning the claims off was a code change and a reviewed PR. It is now
// read from the server environment, defaulting to ON:
//
//   CHORDS_CLAIMS=off   (also: false, 0, no; any case, surrounding spaces ignored)  -> claims OFF
//   unset, empty, or any other value                                              -> claims ON
//
// The default is ON because that is the state the site ships in today. Only an explicit "off"
// word turns the claims off, so a typo leaves the site as it is rather than silently changing it.
//
// WHEN IT IS READ. `chordsLineShown()` reads the variable on every call (never cached), so it
// returns whatever the process it runs in was given. The pages that carry the claim (/, /help,
// /terms, /privacy, /llms.txt) stay STATIC and CDN-cached (review of #332): they call it when they
// are BUILT. On Vercel an environment-variable change applies only to deployments made after the
// change, and a Redeploy runs `next build` again, which re-reads the variable into every static
// page. So the flip is: set CHORDS_CLAIMS=off, press Redeploy. No code change, no PR, no review.
// The dynamic routes that make the claim (/pricing and /loops metadata, the loops page note) and
// the welcome email read it per request / per send, from the same deployment's environment.
// Server-side only: a client component cannot read process.env (only NEXT_PUBLIC_* values are
// inlined), so the client components that make the claim (HomeDemo, LoopsView) receive the value
// as a prop from the server page that renders them.
//
// /terms and /privacy promise "the date above shows the latest version", and the switch changes
// their text. CHORDS_CLAIMS_CHANGED_ON (YYYY-MM-DD, optional) is the date of the flip: each legal
// page shows the LATER of its own last-edited date and that one (legalUpdated() below), so setting
// both variables in the same Redeploy keeps the promise true.
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
//   1. in Vercel production set CHORDS_CLAIMS=off AND CHORDS_CLAIMS_CHANGED_ON=<today, YYYY-MM-DD>,
//      then Redeploy (the rebuild re-reads both into the static pages);
//   2. clear CHORDS_PROVIDER on the worker (Fly secret) the same day, so no new audio goes to
//      Klangio once nothing promises chords; /privacy keeps naming Klangio while any chord data exists.
//   The OFF text of /terms and /privacy is reviewed and pinned today by
//   test/chords-switch-surfaces.test.mjs, so what readers see on flip day is already reviewed.
//
// Gates: test/p7-copy.test.mjs renders the home page with CHORDS_CLAIMS=off (a build with it off); test/
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

/** Optional: the day the operator flipped the switch (YYYY-MM-DD). Server-side only. */
export const CHORDS_CLAIMS_CHANGED_ON_ENV = 'CHORDS_CLAIMS_CHANGED_ON';

/** A real calendar date as YYYY-MM-DD, or null (anything else is ignored, never shown). */
export function parseIsoDay(raw: string | undefined | null): string | null {
  const v = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? v : null;
}

/**
 * The "Last updated" day of a legal page whose text the switch changes: the LATER of the page's
 * own last-edited day (`pageDay`, YYYY-MM-DD) and CHORDS_CLAIMS_CHANGED_ON when that is valid.
 */
export function legalUpdated(pageDay: string): string {
  const flip = parseIsoDay(typeof process === 'undefined' ? undefined : process.env[CHORDS_CLAIMS_CHANGED_ON_ENV]);
  return flip && flip > pageDay ? flip : pageDay;
}
