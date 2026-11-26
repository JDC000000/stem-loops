// Landing copy gate: the demo's alignment claims must match the measured v3 demo
// (documents/stem-loops-landing/demo-assets-v3/FINDINGS.md), and claims that were never true
// (or describe the pre-tempo-fit pipeline) must not come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { landingPage } from './helpers/render-landing-page.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const LANDING = [...walk(join(WEB, 'src/app/(landing)')), ...walk(join(WEB, 'src/components/landing'))]
  .filter((p) => /\.(tsx?|css)$/.test(p))
  .map((p) => [p.slice(WEB.length + 1), readFileSync(p, 'utf8')]);

/**
 * Comments are not copy. POSITIVE gates — the ones a comment could SATISFY — run over
 * comment-stripped source: delete every capability word from the visible page, drop
 * `// player faders mute solo chords` above the component, and an earlier suite stayed green
 * on a page that had been reduced to a bare H1.
 *
 * THIS IS A REGEX STACK, AND A REGEX STACK IS WRONG IN BOTH DIRECTIONS. It is kept only with
 * its blast radius cut to the one direction where being wrong is SAFE, until it is deleted in
 * favour of the single-pass scanner's `withoutComments`/`codeOnly`.
 *
 * STATUS 2026-11-11: #197 HAS merged, so apps/web/test/helpers/code-only.mjs IS now reachable
 * — the precondition the earlier version of this comment was waiting on. Swapping this stack
 * for it is a real change to the apparatus with its own blast radius, so it is NOT bundled
 * into the account-copy fix; it is named residue and the next edit to this file should do it.
 *
 * OVER-inclusive: a `//` inside a string looks like a comment, so real code after it is
 * deleted. On a positive `assert.match` that can only make a gate FAIL on a page that is
 * actually fine — a false RED, which is loud and gets fixed. Tolerable, so it stays.
 *
 * UNDER-inclusive: a STRING literal is not a comment, so a literal can still SATISFY a
 * positive gate. That is a false GREEN and is not tolerable. The one gate it was demonstrated
 * against — the art-drift gate — therefore no longer reads source text at all; it asserts on
 * RENDERED OUTPUT, which no literal can fake (that gate and its helper went with the drawn player, A4).
 *
 * AND THE SAFETY ARGUMENT ABOVE HAS A PRECONDITION. Being wrong only in the false-RED
 * direction holds because every surviving positive gate over this text is a PREFIX or a
 * PRESENCE assertion (`^Needed to play, not to start\.`, `/\bfaders?\b/`, `<dt>Tempo</dt>`),
 * and deleting text
 * can only make those fail. If anyone later writes a positive gate over a WHOLE decommented
 * value — an equality, or a match anchored at both ends — that reasoning stops holding and
 * this must go. Whoever wires up `code-only.mjs` should delete it rather than extend it.
 *
 * BAN LISTS DO NOT USE THIS AT ALL — see RAW_PAGE_AND_COMPONENTS and READ_AS.
 */
const decomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/**
 * The page and the components it owns, with comments stripped. NOT the whole landing: /terms
 * and /privacy are legal copy on their own review path, so these gates deliberately do not
 * police them and must not be read as a site-wide guarantee.
 *
 * THEY ARE NOW OUT OF DATE, and the earlier version of this comment is the reason to say so
 * here rather than quietly. It read: "those two pages say an account is optional, which is
 * TRUE of the shipped system — they need revisiting when Story 1.5 actually lands, not
 * before." Story 1.5 LANDED on 2026-11-11 (#197). Both pages still say "Loops are free and
 * need no account" (/privacy) and "Cutting and downloading loops needs no account"
 * (/terms) — but <LoopResults> renders ONLY inside /jobs/[id], which now redirects a
 * signed-out visitor to /login. So reaching your loops does need an account, and those two
 * sentences are false. Both also say an account is needed to DOWNLOAD the separated stems;
 * there is no stem-download route in the app at all and mintStemDownloadUrl
 * (src/lib/stem-urls.ts:68) has no production consumer. Fixing legal copy is a separate
 * review path and is deliberately NOT in this commit — this is the hand-off.
 */
const PAGE_AND_COMPONENTS = LANDING
  .filter(([f]) => !/\(landing\)\/(?:privacy|terms)\//.test(f))
  .map(([f, src]) => [f, decomment(src)]);

/** page.tsx alone, comments stripped. */
const PAGE = PAGE_AND_COMPONENTS.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];

/**
 * The same files, RAW — nothing stripped. EVERY `doesNotMatch` ban list below reads this and
 * never the stripped copy.
 *
 * Measured on this PR (adversarial sweep round 2, 2026-11-11): one legitimate
 * `aria-label="scope // summary"` on the hero paragraph, with the copy on that same line
 * changed to "No account needed — start a job straight away.", reduced the line to
 * `<p className="audience" aria-label="scope ` before the ban list ran. Both /no account/i and
 * /start(?: a job)? (?:straight|right) away/i returned false, and the gate REPORTED SUCCESS on
 * a page rendering the exact sentence it forbids — tsc --noEmit exit 0, suite unchanged at
 * 925/905/0/20.
 *
 * THIS IS A BACKSTOP, NOT THE GATE. Round 2 shipped it with the argument that "stripping can
 * only REMOVE text from a ban list's view, so a ban list that strips can only be weakened;
 * run raw, the worst case is a false RED." THAT ARGUMENT IS FALSE and two reviewers believed
 * it. It assumes raw source is a superset of rendered text. It is not — JSX text is COMPILED,
 * not copied. `No&nbsp;account needed — start a job straight&nbsp;away.` RENDERS the exact
 * sentence the account gate forbids while the raw source contains neither `no account` nor
 * `straight away`; measured 2026-11-11, suite unchanged at 926/906/0/20 with the gate green.
 * Prettier wrapping a phrase across two lines, `No <strong>account</strong> needed`, and a
 * const or template all do the same.
 *
 * So BOTH source forms are unsound, in different directions: stripped misses what it deletes,
 * raw misses what the compiler produces.
 *
 * RAW IS A WEAK BACKSTOP, AND NOTHING MORE. An earlier version of this comment said it was
 * kept "because it covers two things the render cannot see — the `metadata` description…".
 * IT DOES NOT COVER THE METADATA, in exactly the way the sentence above admits: one literal
 * U+00A0 in the description defeated it (FG7, round 4). Raw catches copy on a branch the
 * default render does not take, and `metadata` before it was read directly — but ONLY against
 * UNOBFUSCATED SOURCE. Any entity, wrap, markup or indirection walks straight past it.
 * `metadata` is now read off the module in READ_AS and no longer depends on this at all.
 *
 * The gate that actually decides is READ_AS.
 */
const RAW_PAGE_AND_COMPONENTS = LANDING.filter(([f]) => !/\(landing\)\/(?:privacy|terms)\//.test(f));

/**
 * The landing page as a human reads it. Rendered once, at module scope, by
 * test/helpers/render-landing-page.mjs — which carries the full argument for why a
 * source-text ban list is unsound in both of its forms.
 *
 * Two normalisations, because evading one walks into the other: `textSpaced` turns every tag
 * into a space (the human reading — this is what kills `No&nbsp;account` and a phrase wrapped
 * across lines) and `textTight` turns every tag into nothing (this kills
 * `no<span> </span>account`, where markup is used to break a banned phrase apart). A ban list
 * asserts against both; either matching is a failure.
 */
const RENDER = await landingPage();
const READ_AS = [
  ['the rendered page', RENDER.textSpaced],
  ['the rendered page, markup removed', RENDER.textTight],
  // The DOM is not the only channel. `metadata` never reaches it, and it is the most-read
  // copy on the site — the <meta name="description"> and the Open Graph card, read in search
  // results and link previews BEFORE anyone opens the page. One literal U+00A0 in the
  // description template put "No account needed — start a job straight away." on the served
  // page with this suite green at 926/906/0/20 (adversarial sweep round 4, 2026-11-11). These
  // two rows also cover OG_TITLE, OG_DESC and OG_ALT, which were in the same blind spot.
  ['the page metadata', RENDER.metaSpaced],
  ['the page metadata, markup removed', RENDER.metaTight],
];

/** The one ceiling. Read from the module the player enforces, so the test cannot drift either. */
const MAX_TRACK_SEC = Number(
  readFileSync(join(WEB, 'src/lib/play/types.ts'), 'utf8').match(/export const MAX_TRACK_SEC = ([\d_]+)/)[1].replace(/_/g, ''),
);
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

const flatten = (s) => s.replace(/<[^>]*>/g, ' ').replace(/[\s\u00a0]+/g, ' ').trim();

/**
 * Slice 1b (design v1.4, P7): the 8-row scope sheet became the "What you get" list. Pull one
 * line out of it by its data-line key, from the RENDERED page, so what the gate reads is the
 * line the reader gets (the old specRow helper read the scope sheet's <dd> the same way). Whole-line equality is safe here: the line is read from
 * RENDERED output (no comment stripping involved), so the precondition note above the
 * decomment() stack does not apply.
 */
const wygLine = (key) => {
  const m = RENDER.html.match(new RegExp(`<li data-line="${key}">([\\s\\S]*?)</li>`));
  assert.ok(m, `the rendered "What you get" list has no "${key}" line`);
  return flatten(m[1]);
};
const WYG_HTML = () => RENDER.html.match(/<ul class="wyg"[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? '';
const rxEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The hero's `.audience` line and one FAQ answer, both from the RENDERED page \u2014 the same
 * reasoning as wygLine.
 *
 * These exist because the first version of this gate asserted ONLY the scope row, and the
 * two sentences the account-copy change actually rewrote had no positive assertion at all.
 * An adversarial review reverted the FAQ answer BYTE-FOR-BYTE to the old false "Yes." and
 * the suite stayed green at 16/16 \u2014 the change this file exists to hold could be undone
 * without a red \u2014 and deleting both hero account sentences outright was green too.
 */
// A4 (2026-11-21): the hero's long `.audience` line is gone (home page diet). The account and
// length facts are stated by the tool's own note under its button, read the same way.
const ctaNote = () => {
  const m = RENDER.html.match(/<p class="hint cta-note">([\s\S]*?)<\/p>/);
  assert.ok(m, 'the rendered tool has no .cta-note line');
  return flatten(m[1]);
};
const faqAnswer = (summary) => {
  const m = RENDER.html.match(new RegExp(`<summary>${rxEscape(summary)}</summary>\\s*<p>([\\s\\S]*?)</p>`));
  assert.ok(m, `the rendered FAQ has no "${summary}" entry`);
  return flatten(m[1]);
};

test('no pre-tempo-fit numbers or never-true claims in the landing', () => {
  const banned = [
    /\b31\s*(?:&nbsp;|\\u00a0| )?ms/i, /\b62\s*(?:&nbsp;|\\u00a0| )?ms/i, /\b124\s*(?:&nbsp;|\\u00a0| )?ms/i,
    /20 ms after/i, /repeats? (?:run|runs) long/i, /time.stretch/i, /101\.3/, /cut to the bar/i,
    /starts on the downbeat/i, /no drift/i, /zero drift/i, /drift-free/i, /phase-locked/i, /sample-accurate/i,
  ];
  for (const [file, src] of LANDING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the H1 stays "Paste a song. Play along."', () => {
  assert.match(PAGE, /Paste a song\.<\/span> <span className="h1-line">Play along\./);
});

// ── Story 0 (2026-11-11): the landing sells the play-along product. These gates exist so
// the loop-downloader positioning, and the binding facts it contradicted, cannot come back.

// POLARITY INVERTED 2026-11-11 (Jon: "make the copy true now, implement API enforcement
// later"). This gate used to assert the OPPOSITE — `^Required\.` plus a ban list on /no
// account/i — and it was built over five adversarial rounds to stop the page claiming
// something untrue. The claim it was protecting turned out to BE the untrue one, so the
// apparatus is kept whole and pointed the other way rather than deleted. Every mechanism the
// five rounds bought survives: both normalisations, the metadata/OG pass, the attribute
// capture and the pilcrow join, all via READ_AS.
//
// WHAT THE SYSTEM ACTUALLY DOES, verified against this tree (5806071) before the copy was
// written — the whole point of the change was that the old copy was written ahead of the code:
//   • POST /api/jobs runs a live anonymous INSERT: ANON_INSERT_SQL declared at route.ts:324,
//     executed at :431 on the `user` ternary at :421. ZERO occurrences of `401` in the file.
//     getUser() (lib/auth/supabase.ts:150) returns null when signed out, so that branch is the
//     signed-out path, not dead code.
//   • POST /api/uploads — the other half of the submit flow — also has zero `401` and no
//     getUser() at all.
//   • src/middleware.ts:28 states outright that it does not enforce auth.
//   • ToolForm.tsx, the submit control on this page, has zero auth references.
// So a signed-out visitor CAN start a job, and the page must not say otherwise.
//
// The other half is true and must stay sayable: /jobs/[id]/page.tsx:32-33 does `getUser()` +
// `redirect('/login?return_to=…')` (Story 1.5, landed in #197), and that page is the only
// thing that renders <Player> and <LoopResults>. So the player, the chord track AND the loops
// need an account; starting does not. The bans below are therefore scoped to the START claim
// and deliberately do NOT forbid saying an account is needed to PLAY.
/**
 * Claims are read SENTENCE BY SENTENCE so that a claim is seen together with its own
 * negation, and the pilcrow is a boundary too so a phrase cannot be assembled across two
 * unrelated `metadata` fields (or a negation borrowed from one).
 *
 * WHY: the first version of this gate matched "need an account to start" inside "You do NOT
 * need an account to start a job". All four of the plainest TRUE phrasings went RED —
 * "You do not need an account to start a job", "No account is required to start one.",
 * "No sign-in required to start a job", "You don't need an account to start one." — while
 * the shipped wording passed. A gate that forces one wording of a true fact is a defect, not
 * a gate; the copy had been bent to fit the list.
 */
const CLAUSES = (t) => t.split(/(?<=[.!?;:])\s+|\s*¶\s*/);

// (A) "an account is needed to START": RETIRED by A4 (2026-11-21), see the test below.

// (B) the OPPOSITE falsehood: that the player, loops, chords or stems need no account. The
//     /jobs/[id] page DOES redirect a signed-out visitor, so these are false. The negation
//     IS the falsehood here, so these are deliberately NOT negation-guarded.
const PLAY_NEEDS_NO_ACCOUNT = [
  /\b(?:player|loops?|chords?|stems?|mixer)\b[^.;!?]{0,60}\b(?:without|no)\b[^.;!?]{0,25}\b(?:an )?(?:account|sign.?in|signing in)/i,
  /\b(?:player|loops?|chords?|stems?|mixer)\b[^.;!?]{0,45}\bopens?\b[^.;!?]{0,25}\b(?:straight away|right away|signed out|for anyone|to anyone)/i,
  /\b(?:open|opens|available|ready)\b[^.;!?]{0,25}\b(?:straight|right) away\b[^.;!?]{0,25}\b(?:for|to) anyone\b/i,
  // Both orders, and SCOPED to the player/data. A bare /no sign.?in (?:needed|required)/
  // also matched the TRUE "No sign-in required to start a job." — the same negation-blind
  // mistake as family A, in the one list that cannot be negation-guarded.
  /\b(?:player|loops?|chords?|stems?|mixer)\b[^.;!?]{0,70}\bno sign.?in (?:needed|required)\b/i,
  /\bno sign.?in (?:needed|required)\b[^.;!?]{0,70}\b(?:player|loops?|chords?|stems?|mixer)\b/i,
  /\b(?:download|downloads|play|plays)\b[^.;!?]{0,25}\bwithout (?:signing in|an account)\b/i,
];

// (C) the claim that the DATA is gated. Only the PAGE is: /jobs/[id]/page.tsx redirects, but
//     api/jobs/[id], .../stems and .../play-chords have NO getUser() and NO 401 (the stems
//     route header says "Deliberately NOT gated on sign-in"), and the job id is handed to the
//     signed-out starter in the 201 body. The privacy page states this plainly; the landing
//     must not contradict it. An earlier draft of this very row said the stems, chords and
//     loops "all open only once you sign in", which is true of the pages and false of the data.
const DATA_IS_GATED = [
  /\b(?:stems?|loops?|chords?|audio|files?|tracks?)\b[^.;!?]{0,55}\b(?:only|just)\b[^.;!?]{0,35}\b(?:once|after|when|if) you (?:sign|log) in/i,
  /\b(?:stems?|loops?|chords?|audio|files?)\b[^.;!?]{0,45}\b(?:are|is|stay|stays)\b[^.;!?]{0,20}\b(?:protected|secured|locked|gated|private|safe)\b/i,
  /\bonly (?:you|signed.?in|logged.?in|account holders?)\b[^.;!?]{0,35}\b(?:can )?(?:see|access|open|fetch|download|play)\b/i,
  /\b(?:sign.?in|an account|your account)\b[^.;!?]{0,25}\b(?:protects|secures|guards|keeps .{0,20}private)\b/i,
];

// A4 (2026-11-21): THE PREMISE OF FAMILY (A) CHANGED, ON PURPOSE. A signed-out visitor who
// submits a LINK now signs in FIRST (components/landing/ToolForm.tsx, lib/pending-link.ts), and the
// song starts as soon as they are back. A FILE still starts signed out. So "you sign in first" is
// now TRUE for a link, and the REQUIRES_TO_START family, which banned saying so, is retired: it
// would force the page to hide the very step the visitor is about to meet. What replaces it is the
// exact rule, pinned whole below, with both halves (link: sign in first; file: starts signed out)
// and the demo half. Families (B) and (C) still run: the player and the data claims are unchanged.
test('the landing states the account rule as it is now: a link signs in first, a file starts signed out, demos need none', () => {
  const faq = faqAnswer('Do I need an account?');
  assert.match(faq, /^To play your own songs, yes: a free one\./);
  assert.match(faq, /When you paste a link signed out, you sign in first and the song starts as soon as you are in\./);
  assert.match(faq, /A file you upload starts straight away and asks you to sign in when its player opens\./);
  assert.match(faq, /The demo songs open without signing in\./);
  assert.match(faq, /on the sign-in page/i);
  // the tool's own note and the demo poster
  assert.match(ctaNote(), /Free account to play your own songs\./);
  assert.match(RENDER.textSpaced, /Try it now · no account needed/);
  // the old unscoped claims must not come back
  for (const [where, text] of [['tool note', ctaNote()], ['FAQ', faq]]) {
    assert.doesNotMatch(text, /Starting a job needs no account|Not to start one\./, `${where} still says starting needs no account`);
    assert.doesNotMatch(text, /The player asks you to sign in/i, `${where} has the unscoped sign-in line`);
  }

  const check = (where, text) => {
    for (const c of CLAUSES(text)) {
      for (const re of PLAY_NEEDS_NO_ACCOUNT) {
        assert.doesNotMatch(c, re, `${where} claims the player needs no account — ${re} in ${JSON.stringify(c.slice(0, 110))}`);
      }
      for (const re of DATA_IS_GATED) {
        assert.doesNotMatch(c, re, `${where} claims the DATA is gated, but only the page is — ${re} in ${JSON.stringify(c.slice(0, 110))}`);
      }
    }
  };
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) check(file, src);
  for (const [where, text] of READ_AS) check(where, text);
});

test('the landing shows no price, plan or paywall — there is no payment at launch', () => {
  // F31 (Jon, 2026-11-13): one link to /pricing is allowed in the landing's own copy (see the next
  // test), so the word "pricing" is banned everywhere except inside that href. Prices and plan
  // names stay banned.
  //
  // P6 (Jon, 2026-11-17): the shared top nav now carries a "Pricing" item on every page, the
  // landing included. That label is the ONE rendered occurrence of the word allowed, and only
  // inside the .sin-bar header; the landing's own source (RAW_PAGE_AND_COMPONENTS, which does
  // not include components/chrome) still may not say it, and the metadata still may not.
  const PRICING_WORD = /(?<!href="\/)\bpricing\b/i;
  const banned = [/\$\d/, /\bper month\b/i, /\/mo\b/, /\bfree forever\b/i, /\bupgrade\b/i, PRICING_WORD, /\bpaid plan/i, /\bcredits\b/i,
    /\bPro\b/, /\bStudio\b/, /\bFree plan\b/i];
  // A4: the footer's one "Pricing" link label (SiteChrome.tsx) is the only allowed source occurrence.
  const FOOTER_LINK = '<a href="/pricing">Pricing</a>';
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) {
    const t = file.endsWith('SiteChrome.tsx') ? src.split(FOOTER_LINK).join('') : src;
    for (const re of banned) assert.doesNotMatch(t, re, `${file} matches ${re}`);
  }
  for (const [where, text] of READ_AS) {
    for (const re of banned) {
      if (re === PRICING_WORD) continue;
      assert.doesNotMatch(text, re, `${where} says ${re}`);
    }
    // No \b: the markup-removed reading joins the nav labels ("LibraryPricingSign in").
    // A4: two labels may say it — the desktop nav item and the footer link (Pricing left the
    // phone bar, so the footer carries it).
    const n = (text.match(/pricing/gi) ?? []).length;
    assert.equal(n, where.startsWith('the page metadata') ? 0 : 2, `${where}: "pricing" ${n} times; only the nav item and the footer link may say it`);
  }
  const header = RENDER.html.match(/<header\b[^>]*class="sin-bar"[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.match(header, /<a\b[^>]*href="\/pricing"[^>]*>Pricing<\/a>/, 'one allowed "Pricing" is the nav item');
  const footer = RENDER.html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? '';
  assert.match(footer, /<a href="\/pricing">Pricing<\/a>/, 'the other is the footer link');
  const body = RENDER.html.replace(header, '').replace(footer, '');
  assert.doesNotMatch(body.replace(/<[^>]*>/g, ' '), /\bpricing\b/i, 'outside the nav and footer, the landing does not say "pricing"');
});

test('the landing links to /pricing from its teaser line and its footer, plus the top-nav item (F31 + P6 + A4)', () => {
  let inSource = 0;
  for (const [, src] of RAW_PAGE_AND_COMPONENTS) inSource += (src.match(/href="\/pricing/g) ?? []).length;
  assert.equal(inSource, 2, 'the landing source carries two /pricing links: the teaser line and the footer');
  // P6 (Jon, 2026-11-17): the shared top nav adds one more on every page (desktop; A4).
  assert.equal((RENDER.html.match(/href="\/pricing/g) ?? []).length, 3, 'the rendered page: the teaser line, the footer and the nav item');
  assert.match(RENDER.html, /<a href="\/pricing">See the monthly song limits →<\/a>/, 'the pricing teaser line');
  const header = RENDER.html.match(/<header\b[^>]*class="sin-bar"[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.equal((header.match(/href="\/pricing/g) ?? []).length, 1, 'exactly one of them is in the nav');
});

test('the landing states the device scope truthfully and phone first (Story 8; A4 2026-11-21)', () => {
  // Jon 2026-11-15: the product must work on phones; 2026-11-21 (A4): the copy leads with the phone.
  // True in code: the phone player shipped (#278/#288) and loads lighter audio
  // (lib/play/device-support.ts). The desktop-first line is gone, and must not come back.
  assert.match(RENDER.textSpaced, /on your phone or your computer\./);
  for (const [where, text] of READ_AS) {
    assert.doesNotMatch(text, /Best in Chrome on a computer|phone support is new/i, `${where} still ranks the computer above the phone`);
  }
  // The untested-browser caveat lives in the FAQ on /help now; the home page no longer
  // carries a "Which browsers work?" answer.
  const banned = [/works (?:great |fine |perfectly )?on (?:any|every|all) (?:phone|mobile|device)/i, /\bany browser\b/i, /\bevery browser\b/i,
    /mobile.friendly/i, /runs? (?:fine |well |great )on (?:a )?(?:tablet|handset|phone|mobile)/i, /phones are not supported/i,
    /desktop only/i, /needs a desktop/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
});

test('the landing names where Speed and Capo / transpose are (the ⋯ menu), and overclaims neither', () => {
  // QW-4 (QA 2026-11-26): Speed (Beta, 90% / 75%, pitch kept) and Capo / transpose shipped in the
  // player's ⋯ menu with no flag, so the old "Coming soon: slow a song down" line went false. It is
  // now one "In the player's ⋯ menu" line, read from the RENDERED page so that a commented-out or
  // hidden line cannot satisfy it.
  const more = RENDER.html.match(/<p class="wyg-more"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(more, 'the "In the player\u2019s \u22ef menu" line is not rendered');
  assert.equal(flatten(more[1]), 'In the player\u2019s \u22ef menu: slow down to 90% or 75%, same pitch (Beta), or set a capo.');
  // The rates are the engine's, not typed from memory.
  const rates = readFileSync(join(WEB, 'src/lib/play/engine.ts'), 'utf8').match(/export const PLAYBACK_RATES = \[([^\]]*)\]/)[1];
  assert.equal(rates.replace(/\s/g, ''), '1,0.9,0.75', 'PLAYBACK_RATES changed: update the home line and the FAQ');
  // No "coming soon" for either any more, and it is still NOT one of the "What you get" lines.
  for (const [where, text] of READ_AS) assert.doesNotMatch(text, /coming soon/i, `${where} still says "coming soon"`);
  assert.doesNotMatch(flatten(WYG_HTML()), /\bslow\b|\btempo\b|\bpitch\b|\bcapo\b/i);
  // Never overclaimed: no half speed (50% is not offered) and no key change of the AUDIO.
  const banned = [/\bhalf speed\b/i, /\b50 ?%/, /\bchange (?:the|its) key\b(?!\?)(?![^.]*\bnot\b)/i, /\bpitch.shift/i, /\bany speed\b/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
});

test('the landing invents no social proof — production has zero registered users', () => {
  const banned = [/\btestimonial/i, /\d[\d,.]*\s*(?:\+\s*)?(?:happy\s+)?(?:users|musicians|players|customers|members)\b/i,
    /\bloved by\b/i, /\btrusted by\b/i, /\bas seen (?:in|on)\b/i, /\b\d(?:\.\d)?\s*\/\s*5\b/, /\bstars?\b/i, /\breviews?\b/i, /\bjoin \d/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
});

test('every minute figure on the page IS MAX_TRACK_MIN, not merely not-the-literal', () => {
  // The old gate banned the CORRECT figure and nothing else, so a WRONG one sailed through:
  // {MAX_TRACK_MIN} -> {6} rendered "Up to 6 minutes" against a 300 s ceiling, in the page and
  // in the meta description, with a green suite (adversarial sweep, 2026-11-11).
  // A4: the home page states the cap once, in the tool's note (ToolForm.tsx).
  const TOOL = PAGE_AND_COMPONENTS.find(([f]) => f.endsWith('components/landing/ToolForm.tsx'))[1];
  assert.match(TOOL, /import \{[^}]*\bMAX_TRACK_SEC\b[^}]*\} from '@\/lib\/play\/types'/);
  assert.match(TOOL, /MAX_TRACK_MIN = Math\.floor\(MAX_TRACK_SEC \/ 60\)/);
  assert.equal(MAX_TRACK_MIN, Math.floor(MAX_TRACK_SEC / 60));

  // Every "… minutes" in the page and the tool must be fed by the binding, in {…} or ${…}.
  const uses = [PAGE, TOOL].flatMap((src) => [...src.matchAll(/\{([^{}]*)\}(?:&nbsp;|\\u00a0|\s)*minutes?/g)].map((m) => m[1].trim()));
  assert.ok(uses.length >= 1, `expected the cap to appear at least once, saw ${uses.length}`);
  for (const u of uses) assert.equal(u, 'MAX_TRACK_MIN', `a minute figure is fed by ${JSON.stringify(u)}`);
  assert.match(RENDER.textSpaced, new RegExp(`Uses the first ${MAX_TRACK_MIN} minutes of any song`));

  // …and no literal minute figure, in digits or in words, anywhere in the marketing copy.
  const literal = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:&nbsp;|\\u00a0|\s)*minutes?\b/i;
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) {
    // the "1–3 minutes" processing-time answer is a measured runtime, not the cap
    const withoutRuntime = src.replace(/about 1–3\s*minutes/g, '').replace(/3 min 7 s/g, '');
    assert.doesNotMatch(withoutRuntime, literal, `${file} hard-codes a minute figure`);
  }
});

test('A4: the demo is shown once — no drawn player, no example lanes, no own-page link, no pipeline section', () => {
  // Jon's J1 story review (2026-11-20): the home page showed the demo three ways. Now the live
  // demo card is the only one, and the "From one song to a player" pipeline section is gone.
  assert.equal((RENDER.html.match(/data-testid="home-demo"/g) ?? []).length, 1);
  assert.doesNotMatch(RENDER.html, /<figure class="player">|class="pl-ch|class="lanes|id="how"|id="play"/);
  assert.doesNotMatch(RENDER.textSpaced, /What playing along looks like|From one song to a player|Open it on its own page/);
  assert.doesNotMatch(PAGE, /PlayerArt|Lanes|DemoArt|DemoProvider/);
  // three one-line proof points
  assert.equal((RENDER.html.match(/<li data-line="/g) ?? []).length, 3);
});

test('the page claims no submit-time length gate — a long song is trimmed, not refused', () => {
  // 2026-11-14 (Jon): "If a song is more than 5 minutes, it should still be converted to a play
  // along, but it just [processes the first] 5 minutes." The worker trims every input to its
  // first MAX_UPLOAD_DURATION_SEC seconds, so nothing is turned away for length and the page
  // must not say anything is.
  const banned = [/\brefused\b/i, /\brejected\b/i, /\bturned away\b/i, /\bwon't be accepted\b/i, /\bwe'll stop you\b/i,
    /\bnot supported\b[^.]*\blonger\b/i, /\blonger tracks are not\b/i, /-minute limit/i, /choose a shorter song/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} claims a gate that does not exist (${re})`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} claims a gate that does not exist (${re})`);
  // A4: the cap and the trim are stated by the tool's own note (terms are compared against it in
  // legal-terms-copy).
  assert.match(ctaNote(), new RegExp(`^Uses the first ${MAX_TRACK_MIN} minutes of any song; a longer one is trimmed on our end\\.`));
  assert.doesNotMatch(RENDER.textSpaced, /on our side/i, '"on our side" is on the brand-tone avoid list');
});

test('the form carries the pre-submit trim note slot, empty until a long file is picked', () => {
  // lib/upload-duration.ts words the note; ToolForm shows it under the picked file. Rendered
  // with no file, the slot exists and is hidden, so the landing never shows it by default.
  assert.match(RENDER.html, /<p class="hint" id="picked-notice" data-testid="trim-notice" hidden="">/);
});

test('the page itself names the player, the faders, mute, solo, the chords and the loop', () => {
  // Two earlier versions of this gate were satisfied without the page saying anything (a
  // comment, or the words surviving in one component). A4: the words now live in the three
  // proof points and the demo note, so the gate reads the RENDERED page, which no comment or
  // dead literal can satisfy.
  for (const re of [/\bplayer\b/i, /\bfaders?\b/i, /\bmute\b/i, /\bsolo\b/i, /\bchords?\b/i, /\bsection\b/i, /6 stems/i]) {
    assert.match(RENDER.textSpaced, re, `the rendered landing page never says ${re}`);
  }
});

// A4 (2026-11-21): three gates went with what they guarded — "the drawing shows what the copy
// claims" (PlayerArt), "drift is stated as a per-length upper bound" (the example lanes' drift
// copy, demo-data.ts) and the .pl-band breakpoint (the drawn player's layout). The drawn player,
// the lanes and their data module are deleted, so there is nothing left for them to read.

test('the demo loop file is the v3 set', () => {
  // A4: the example lanes (which read demo-assets-v3/) are gone; the loops intro's WAV stays v3.
  const cfg = readFileSync(join(WEB, 'src/lib/public-config.ts'), 'utf8');
  assert.doesNotMatch(cfg, /DEMO_DATA_BASE|DEMO_BEFORE_PEAKS_URL/);
  assert.match(cfg, /'assets-v3\/'/);
  assert.match(cfg, /lucky_ticket_drums_102\.0bpm_G_minor_verse_0006\.wav/);
});

// Front door: the one-time email link is sent with shouldCreateUser:false (lib/auth/magic-link.ts),
// so for a first-time visitor it sends nothing. The landing must not sell it as a way IN.
//
// HOW THIS IS PINNED, and why both halves. The first version asserted substrings
// (/create an account/, /one-time link[^.]*already exists/, /on the sign-in page/). An adversarial
// review rewrote both blocks to say the OPPOSITE ("you do not have to create an account ... just
// ask for the one-time link, which works whether or not an account already exists, and creates one
// for you") and every one of those substrings still matched: suite green, copy wrong.
//   1. EXACT SENTENCES. The two claims that matter are asserted whole, as rendered. An inversion
//      has to delete or reword one of them, so it goes red. Surrounding prose may still change.
//   2. BANNED PHRASES. A sentence can also be left alone and contradicted next to it. The ban list
//      names the words an inversion needs ("creates one", "no need", "do not have to", "whether or
//      not"). Anyone who loosens (1) to a pattern is still stopped by (2).
// The anti-enumeration rule is unaffected: none of this copy depends on the address.
const tidy = (s) => s.replace(/\s+([.,;:])/g, '$1'); // flatten() leaves "page ." where a link closes
const ACCOUNT_CLAIM = 'If you are new, you create an account on the sign-in page.';
// Slice 1b (P7): the spec sheet's Account row is gone; the FAQ answer carries both claims.
const ONE_TIME_LINK_CLAIMS = {
  FAQ: 'A one-time link sent to your email only signs you back in to an account that already exists; it does not create one.',
};
const ACCOUNT_COPY_INVERSIONS = [
  /\bcreates (?:one|an account|your account|it)\b/i,
  /\bno need to (?:create|sign up|register)\b/i,
  /\b(?:do not|don't|does not|doesn't) have to (?:create|sign up|register)\b/i,
  /\bwhether or not\b/i,
  /\bjust (?:ask|request|use|send)\b/i,
];

test('the landing says a new visitor creates an account, and the one-time link only signs an existing one back in', () => {
  const blocks = { FAQ: faqAnswer('Do I need an account?') };
  for (const [where, raw] of Object.entries(blocks)) {
    const text = tidy(raw);
    assert.doesNotMatch(text, /or a one-time link/i, `${where} still offers the link as an alternative way in`);
    assert.ok(text.includes(ACCOUNT_CLAIM), `${where} lost the sentence "${ACCOUNT_CLAIM}"\n  got: ${text}`);
    assert.ok(
      text.includes(ONE_TIME_LINK_CLAIMS[where]),
      `${where} lost the sentence "${ONE_TIME_LINK_CLAIMS[where]}"\n  got: ${text}`,
    );
    for (const re of ACCOUNT_COPY_INVERSIONS) assert.doesNotMatch(text, re, `${where} says the opposite (${re})`);
  }
});

test('CANARY: the inversion ban list still matches the wording it exists to stop', () => {
  const inverted = [
    'If you are new, you do not have to create an account; just ask for the one-time link by email, which works whether or not an account already exists, and creates one for you.',
    'There is no need to create an account.',
    'The one-time link creates one for you.',
  ].join(' ');
  for (const re of ACCOUNT_COPY_INVERSIONS) assert.match(inverted, re, `${re} no longer matches any inversion`);
  // ...and does not match the true copy, or the gate above could never pass.
  for (const re of ACCOUNT_COPY_INVERSIONS) {
    assert.doesNotMatch([ACCOUNT_CLAIM, ...Object.values(ONE_TIME_LINK_CLAIMS)].join(' '), re);
  }
});

test('FAQ: files are deleted after 24 hours, and a subscription keeps a library for 30 days after (2026-11-15)', () => {
  const a = faqAnswer('What happens to my files?');
  assert.match(a, /Sources, stems and loops are deleted after 24 hours\./);
  assert.match(a, /With a subscription, the songs in your account are kept as a library while you subscribe, and for 30 days after it ends\./);
});
