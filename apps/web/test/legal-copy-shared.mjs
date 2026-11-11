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
    // There is no stem-download route. `mintStemDownloadUrl` (src/lib/stem-urls.ts:68) has
    // ZERO production consumers — the only references are its own definition and
    // test/stem-urls-contract.test.mjs. The claim described a feature that does not exist.
    'stem downloads need an account — there is no stem-download route at all',
    /download(?:ing)?\s*the\s*separated\s*stems/i,
  ],
  [
    'stem downloads need an account (restated)',
    /stems?\s*downloads?\s*(?:needs?|requires?)\s*an\s*account/i,
  ],
  [
    // Old privacy: "Loops are free and need no account".
    // Old terms: "Cutting and downloading loops needs no account".
    // False since the player gate landed: src/app/jobs/[id]/page.tsx:32-33 does
    // `getUser()` then `redirect('/login?return_to=…')`, so NO result — loops included —
    // is reachable without an account.
    'loops (or anything else) need no account — the player gate makes every result account-only',
    /(?:needs?|requires?|required)\s*no\s*account/i,
  ],
  [
    'no account needed',
    /no\s*account\s*(?:needed|required|necessary)/i,
  ],
  [
    // Drafted for this page and caught in review: /pricing sells Pro ($4.99 CAD/mo),
    // Studio ($12 CAD/mo) and credit packs ($5/$12/$30 CAD) through Stripe, and a
    // signed-in free-plan upload is refused with CREDIT_BALANCE_INSUFFICIENT at a zero
    // balance (src/lib/billing/entitlements.ts:309-318).
    'there is nothing to pay for — /pricing sells plans and credit packs',
    /nothing\s*to\s*pay\s*for/i,
  ],
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
