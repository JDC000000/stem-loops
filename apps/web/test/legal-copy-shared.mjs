// Shared vocabulary for the two legal-copy gates (terms + privacy).
//
// NOT a `.test.mjs` file on purpose: `pnpm test`'s glob is `test/*.test.mjs`, so this module
// is imported by the two gates and never run as a suite of its own. That keeps the suite's
// test COUNT equal to the number of real assertions, which is what the mutation procedure in
// claude/ compares before and after — a helper that contributed phantom tests would blur it.
//
// WHY A PHRASE BUILDER AND NOT A STRING `includes`.
// Every assertion here runs against BOTH normalisations produced by
// test/helpers/render-landing-page.mjs:
//   textSpaced — every tag becomes a space (kills `no&nbsp;account` and line wrapping)
//   textTight  — every tag becomes nothing (kills `no<span> </span>account`)
// Those two disagree about whitespace at element boundaries by construction: a phrase broken
// by markup reads `a b` in one and `ab` in the other. So a phrase is compiled to a pattern
// whose words are joined by `\s*` — zero or more — and the SAME pattern is then correct in
// both. A literal `includes` would be satisfiable in one normalisation and not the other,
// which is the false-green this whole harness exists to close.

/** Regex-escape, then let either apostrophe form match — the copy uses U+2019, tests type '. */
const esc = (w) =>
  w
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/['’]/g, "['’]");

/** `phrase("you need an account")` -> /you\s*need\s*an\s*account/i. See the note above. */
export const phrase = (s) => new RegExp(s.trim().split(/\s+/).map(esc).join('\\s*'), 'i');

/**
 * Sentences that were on these pages and were NOT TRUE. Banned by RENDERED form on BOTH
 * pages and in BOTH normalisations, and in the page `metadata` as well, so neither can come
 * back through a reword, a wrap, an entity, a span, or the search snippet.
 *
 * Each entry is [why it is banned, pattern].
 */
export const BANNED = [
  [
    // Old terms: "downloading the separated stems does [need an account]".
    // Old privacy: "An account is needed only to download the separated stems."
    // There is no stem-download route at all. `mintStemDownloadUrl` (src/lib/stem-urls.ts:68)
    // has ZERO production consumers — its own definition and test/stem-urls-contract.test.mjs.
    // The claim described a feature that does not exist, which is why THIS half of the old
    // sentence is banned and the "loops need no account" half is not: see the note below.
    'stem downloads need an account — there is no stem-download route at all',
    /download(?:ing)?\s*the\s*separated\s*stems/i,
  ],
  [
    'stem downloads need an account (restated)',
    /stems?\s*downloads?\s*(?:needs?|requires?)\s*an\s*account/i,
  ],
  [
    // Shipped in the first cut of this PR and caught in review. It overstates the
    // protection: /api/jobs/[id], /api/jobs/[id]/stems and /api/jobs/[id]/play-chords
    // NEVER call getUser(). Only the HTML page redirects. A job UUID alone reaches the
    // audio and a presigned R2 URL per stem, with no account anywhere in the path — the
    // stems route's own header names a leaked UUID as the threat it is guarding.
    'a job link plus an account is the gate — the gate is on the PAGE only, not on the files',
    /link\s*and\s*an\s*account/i,
  ],
  [
    // The ABSOLUTE form only. /pricing sells Pro ($4.99 CAD/mo), Studio ($12 CAD/mo) and
    // credit packs, and src/lib/billing/entitlements.ts:309-318 refuses a free-plan upload
    // at a zero credit balance. A QUALIFIED sentence ("free to use at the moment", "while
    // billing is off there is nothing to pay for") is true and must stay sayable, so this
    // pattern pins the unqualified claim rather than the words "nothing to pay for".
    'it is free and there is nothing to pay for — stated absolutely, with no qualifier',
    /(?:it\s*is|it[\u2019']s)\s*free,?\s*and\s*there\s*is\s*nothing\s*to\s*pay\s*for/i,
  ],
];

// DELIBERATELY NOT BANNED: "needs no account" / "no account needed" in general.
// An earlier cut of this file banned those outright. That was an OVER-BAN — it forbade
// sentences that are TRUE: you can start a job without an account (api/jobs/route.ts has
// zero 401s and an anonymous INSERT branch), and after the Links-to-jobs correction above,
// reaching a job by its link needs no account either. A gate that forbids the truth is its
// own defect, so the bans are now tied to the two claims that are false however they are
// phrased: a stem-download feature that does not exist, and the account-protects-the-link
// overstatement.

/**
 * Every processor the privacy page must name, with the file that proves it receives
 * something. ASSERTED ONE BY ONE — an earlier cut asserted only the four that were new in
 * this PR while its header claimed the list was checked "name by name", and a reviewer
 * deleted Cloudflare R2, Supabase, Sentry and the proxy sentence with the suite still green.
 * An overclaim in a disclosure gate is a false green with a softer voice.
 */
export const PROCESSORS = [
  ['Replicate', 'apps/worker/src/worker/replicate_client.py:44 — POSTs audio to api.replicate.com'],
  ['Klangio', 'chord_providers/klangio.py:574 — POST /chord-recognition, multipart, field `file`'],
  ['Cloudflare R2', 'src/lib/r2.ts + stem-urls.ts — stores and presigns every object'],
  ['Fly.io', 'the worker host'],
  ['Vercel', 'the web host'],
  ['Supabase', 'src/lib/auth/supabase.ts + src/lib/db.ts — auth and the job database'],
  ['Google', 'src/components/LoginForm.tsx:135-136 — signInWithOAuth({ provider: "google" })'],
  ['hCaptcha', 'src/lib/hcaptcha.ts + api/auth/signup/route.ts:37'],
  ['Stripe', 'src/lib/billing/providers/stripe.ts + api/billing/{checkout,portal,webhook}'],
  ['Resend', 'src/lib/emails/resend.ts:23 — POSTs to api.resend.com with the address in `to:`'],
  ['Sentry', 'src/lib/sentry-options.ts — error reports'],
];

/**
 * Run the ban list over one page's four rendered channels.
 *
 * `metaSpaced`/`metaTight` are asserted for the reason given at length in the render helper:
 * `export const metadata` NEVER reaches the DOM, so a DOM-only gate cannot see the
 * `<meta name="description">` or the Open Graph card — which is the copy read in search
 * results and link previews BEFORE anyone opens the page.
 */
export function assertNoBannedClaims(assert, page, label) {
  for (const [why, re] of BANNED) {
    for (const [channel, text] of [
      ['rendered text, tags→space', page.textSpaced],
      ['rendered text, tags→nothing', page.textTight],
      ['metadata, tags→space', page.metaSpaced],
      ['metadata, tags→nothing', page.metaTight],
    ]) {
      assert.doesNotMatch(text, re, `${label} (${channel}) must not claim: ${why}`);
    }
  }
}

/** Assert a phrase is present in BOTH rendered normalisations. */
export function assertSays(assert, page, text, label) {
  const re = phrase(text);
  assert.match(page.textSpaced, re, `${label} (tags→space) must say: ${text}`);
  assert.match(page.textTight, re, `${label} (tags→nothing) must say: ${text}`);
}
