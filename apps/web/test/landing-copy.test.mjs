// Landing copy gate: the demo's alignment claims must match the measured v3 demo
// (documents/stem-loops-landing/demo-assets-v3/FINDINGS.md), and claims that were never true
// (or describe the pre-tempo-fit pipeline) must not come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { playerArt } from './helpers/render-player-art.mjs';
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
 * RENDERED OUTPUT, which no literal can fake. See test/helpers/render-player-art.mjs.
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

/**
 * Pull one <dd> out of the scope sheet by its <dt>, from the RENDERED page — so what the gate
 * reads is the row the reader gets, with the JSX `{' '}` artifacts and the entities already
 * resolved.
 *
 * These stay PREFIX assertions on purpose (`^Required\.`). Everything after the prefix is
 * policed by the ban lists, which is sound now that they read the rendered page: appending
 * "In practice no account is needed yet — you can start a job straight away." to this row
 * passed the prefix AND evaded a raw ban list, suite unchanged (2026-11-11).
 */
const specRow = (dt) => {
  const m = RENDER.html.match(new RegExp(`<dt>${dt}</dt>\\s*<dd>([\\s\\S]*?)</dd>`));
  assert.ok(m, `the rendered scope sheet has no "${dt}" row`);
  return m[1].replace(/<[^>]*>/g, ' ').replace(/[\s\u00a0]+/g, ' ').trim();
};

const flatten = (s) => s.replace(/<[^>]*>/g, ' ').replace(/[\s\u00a0]+/g, ' ').trim();
const rxEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The hero's `.audience` line and one FAQ answer, both from the RENDERED page \u2014 the same
 * reasoning as specRow.
 *
 * These exist because the first version of this gate asserted ONLY the scope row, and the
 * two sentences the account-copy change actually rewrote had no positive assertion at all.
 * An adversarial review reverted the FAQ answer BYTE-FOR-BYTE to the old false "Yes." and
 * the suite stayed green at 16/16 \u2014 the change this file exists to hold could be undone
 * without a red \u2014 and deleting both hero account sentences outright was green too.
 */
const audienceLine = () => {
  const m = RENDER.html.match(/<p class="audience">([\s\S]*?)<\/p>/);
  assert.ok(m, 'the rendered hero has no .audience line');
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
const NEGATED = /\b(?:no|not|never|without|none|nothing)\b|n['’]t/i;

// (A) "an account is needed to START". Negation-aware: a clause that negates the claim is
//     stating the truth and must pass. Scoped to STARTING, so "the player asks you to sign
//     in" — which is true — is not banned.
const REQUIRES_TO_START = [
  /\byou need an account\s*[.!]/i,                 // unqualified; no negated form matches this
  /required\.\s*sign in/i,                         // the old scope-sheet row, verbatim
  /\bneeds? an account\b[^.;!?]{0,40}\b(?:to|before)\b[^.;!?]{0,25}\b(?:start|paste|submit|run|use|upload|get going)/i,
  /\ban account\b[^.;!?]{0,25}\brequired\b[^.;!?]{0,40}\b(?:to|before)\b[^.;!?]{0,25}\b(?:start|paste|submit|run|use|upload)/i,
  /\b(?:sign.?in|sign.?up|log ?in|logging in)\b[^.;!?]{0,25}\b(?:is )?required\b/i,
  /\bmust\b[^.;!?]{0,25}\b(?:sign|log) in\b/i,
  /\b(?:create|make|get|open)\b[^.;!?]{0,25}\b(?:free )?account\b[^.;!?]{0,35}\b(?:first|to (?:get )?start)/i,
  /\b(?:sign|log) ?in\b[^.;!?]{0,25}\b(?:first|to start|to get started)\b/i,
  /\b(?:form|input|tool|uploader|box)\b[^.;!?]{0,45}\bunlocks?\b/i,
  /\bno (?:job|jobs|songs?) without an account\b/i,
];

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

test('the landing never claims an account is required to START — nothing enforces one', () => {
  // POSITIVE, on ALL THREE places the page speaks about accounts, each read from the RENDERED
  // page. See audienceLine/faqAnswer above for why the hero and the FAQ are asserted now.
  assert.match(audienceLine(), /Starting a job needs no account/);
  assert.match(faqAnswer('Do I need an account?'), /^Not to start one\./);
  assert.match(specRow('Account'), /^Needed to play, not to start\./);
  // …and the row must still carry the half that IS true. `on the sign-in page` rather than a
  // bare /sign in/i, which "no sign in needed" satisfies by containing the words.
  assert.match(specRow('Account'), /on the sign-in page/i);

  const check = (where, text) => {
    for (const c of CLAUSES(text)) {
      if (!NEGATED.test(c)) {
        for (const re of REQUIRES_TO_START) {
          assert.doesNotMatch(c, re, `${where} claims an account is needed to start — ${re} in ${JSON.stringify(c.slice(0, 110))}`);
        }
      }
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
  // F31 (Jon, 2026-11-13): one link to /pricing is allowed (see the next test), so the word
  // "pricing" is banned everywhere except inside that href. Prices and plan names stay banned.
  const banned = [/\$\d/, /\bper month\b/i, /\/mo\b/, /\bfree forever\b/i, /\bupgrade\b/i, /(?<!href="\/)\bpricing\b/i, /\bpaid plan/i, /\bcredits\b/i,
    /\bPro\b/, /\bStudio\b/, /\bFree plan\b/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
});

test('the landing links to /pricing exactly once (F31, Jon 2026-11-13)', () => {
  let inSource = 0;
  for (const [, src] of RAW_PAGE_AND_COMPONENTS) inSource += (src.match(/href="\/pricing/g) ?? []).length;
  assert.equal(inSource, 1, 'the landing source must carry exactly one /pricing link');
  assert.equal((RENDER.html.match(/href="\/pricing/g) ?? []).length, 1, 'the rendered page must carry exactly one /pricing link');
});

test('the landing claims no mobile or non-Chrome support (Story 5.3)', () => {
  // Positive first: the row has to SAY the scope. A ban list alone let "Chrome, and it runs
  // fine on a tablet or a handset too" through (adversarial sweep, 2026-11-11).
  assert.match(specRow('Where it runs'), /^Chrome, on a desktop\./);
  assert.match(specRow('Where it runs'), /not supported yet/);
  const banned = [/works on (?:your |a )?(?:phone|mobile|ios|android|tablet|handset)/i, /\bany browser\b/i, /\bevery browser\b/i,
    /mobile.friendly/i, /runs? (?:fine |well |great )?on (?:a )?(?:tablet|handset|phone|mobile)/i, /(?:tablet|handset|phone)s? (?:too|as well)\b/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
});

test('the landing says tempo and pitch are coming, and never implies we have them', () => {
  // Comment-stripped, NOT raw. Wrapping the three spec-later rows — Tempo, Pitch and capo,
  // Lyrics — in a JSX comment deletes all three from the rendered page, and reading raw source
  // left this gate GREEN with every one of them gone (adversarial sweep round 2, 2026-11-11):
  // tsc --noEmit exit 0, suite unchanged at 925/905/0/20.
  const page = PAGE;
  // both gaps are named on the page
  assert.match(page, /<dt>Tempo<\/dt>/);
  assert.match(page, /<dt>Pitch and capo<\/dt>/);
  // and each is answered "Not yet" in its own row, so the gap is stated, not discovered
  for (const dt of ['Tempo', 'Pitch and capo']) {
    const row = page.match(new RegExp(`<dt>${dt}</dt>\\s*<dd>([^<]*)`));
    assert.ok(row, `no <dd> for the ${dt} row`);
    assert.match(row[1], /^Not yet\./, `the ${dt} row must open with "Not yet." — got ${JSON.stringify(row[1].slice(0, 40))}`);
  }
  // and the marketing copy never offers either as something you can do today
  const banned = [/\byou can slow\b/i, /\bslow it down\b(?![^.]*\bnot\b)/i, /\bhalf speed\b/i, /\btranspose\b/i, /\bchange its key\b(?![^.]*\bnot\b)/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
  // lyrics are out of scope (not "coming"), and the page says so in its own row
  const lyrics = page.match(/<dt>Lyrics<\/dt>\s*<dd>([^<]*)/);
  assert.ok(lyrics, 'no <dd> for the Lyrics row');
  assert.match(lyrics[1], /^No\./, `the Lyrics row must open with "No." — got ${JSON.stringify(lyrics[1].slice(0, 40))}`);
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
  assert.match(PAGE, /import \{ MAX_TRACK_SEC \} from '@\/lib\/play\/types'/);
  assert.match(PAGE, /MAX_TRACK_MIN = Math\.floor\(MAX_TRACK_SEC \/ 60\)/);
  assert.equal(MAX_TRACK_MIN, Math.floor(MAX_TRACK_SEC / 60));

  // Every "… minutes" on the page must be fed by the binding, in {…} or ${…}.
  const uses = [...PAGE.matchAll(/\{([^{}]*)\}(?:&nbsp;|\\u00a0|\s)*minutes?/g)].map((m) => m[1].trim());
  assert.ok(uses.length >= 2, `expected the cap to appear at least twice, saw ${uses.length}`);
  for (const u of uses) assert.equal(u, 'MAX_TRACK_MIN', `a minute figure is fed by ${JSON.stringify(u)}`);

  // …and no literal minute figure, in digits or in words, anywhere in the marketing copy.
  const literal = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:&nbsp;|\\u00a0|\s)*minutes?\b/i;
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) {
    // the "1–3 minutes" processing-time answer is a measured runtime, not the cap
    const withoutRuntime = src.replace(/about 1–3\s*minutes/g, '').replace(/3 min 7 s/g, '');
    assert.doesNotMatch(withoutRuntime, literal, `${file} hard-codes a minute figure`);
  }
});

test('the page renders <PlayerArt /> — the one object the play section is built on', () => {
  // Deleting the element left the suite green, because the capability words survived in the
  // surrounding prose (adversarial sweep, 2026-11-11).
  assert.match(PAGE, /import \{ PlayerArt \} from '@\/components\/landing\/PlayerArt'/);
  assert.match(PAGE, /<PlayerArt\s*\/>/);
  // …and it is in the RENDERED page. Both lines above are source text, which a dead string
  // literal can satisfy; a literal cannot put a mounted component into rendered HTML.
  assert.match(RENDER.html, /<figure class="player">/, 'the rendered page has no player illustration');
  // scoped to the rail: `data-stem` is also used by the hero's example lanes.
  assert.equal((RENDER.html.match(/<div class="pl-ch[^"]*" data-stem="/g) ?? []).length, 6,
    'the rendered page must carry the six-channel mixer rail');
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
  assert.match(specRow('Track length'), new RegExp(`^The first ${MAX_TRACK_MIN} minutes of any song\\.`));
  assert.match(specRow('Track length'), /trimmed on our end/);
  assert.doesNotMatch(specRow('Track length'), /on our side/i, '"on our side" is on the brand-tone avoid list');
});

test('the form carries the pre-submit trim note slot, empty until a long file is picked', () => {
  // lib/upload-duration.ts words the note; ToolForm shows it under the picked file. Rendered
  // with no file, the slot exists and is hidden, so the landing never shows it by default.
  assert.match(RENDER.html, /<p class="hint" id="picked-notice" data-testid="trim-notice" hidden="">/);
});

test('the page itself names the player, the faders, mute, solo, the chords and the loop', () => {
  // Two earlier versions of this gate were satisfied without the page saying anything:
  //  - joining every landing file let the words survive in PlayerArt.tsx alone;
  //  - reading raw source let a single `// player faders mute solo chords` line comment
  //    satisfy it while the visible page was reduced to a bare H1.
  // So: page.tsx only, comments stripped. Each of these is a row of the approved table.
  for (const re of [/\bplayer\b/i, /\bfaders?\b/i, /\bmute\b/i, /\bsolo\b/i, /\bchords?\b/i, /section of the song/i, /six stems|<dd>Six —/i]) {
    assert.match(PAGE, re, `the landing page never says ${re}`);
  }
  // …and the RENDERED page says them, which source text alone cannot prove: a dead literal
  // satisfies a source-text `match`, and a commented-out section still reads as prose here.
  for (const re of [/\bplayer\b/i, /\bfaders?\b/i, /\bmute\b/i, /\bsolo\b/i, /\bchords?\b/i, /section of the song/i, /six stems|\bSix —/i]) {
    assert.match(RENDER.textSpaced, re, `the rendered landing page never says ${re}`);
  }
});

test('the drawing shows what the copy claims — the art and the page cannot drift apart', async () => {
  // The page says six faders with a mute and a solo, a chord track and a section loop. If
  // PlayerArt stops drawing any of that, the page is claiming something its own illustration
  // contradicts.
  //
  // This gate reads RENDERED HTML, not source text. Grepping the source let a dead
  // `title="toggles: >M< mute, >S< solo"` attribute hold this green with BOTH TOGGLES DELETED
  // from the component (adversarial sweep round 2, 2026-11-11): tsc --noEmit exit 0, suite
  // unchanged at 925/905/0/20. Stripping comments would not have caught it, because a literal
  // is not a comment. React escapes attribute values, so `>M<` can only reach the output as a
  // real text node between real tags — a property no literal can fake and no scanner is needed
  // to check.
  const { html, STEM_ORDER } = await playerArt();

  // six channels, and they are the REAL STEM_ORDER in order — not six of anything
  const drawn = [...html.matchAll(/<div class="pl-ch[^"]*" data-stem="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(STEM_ORDER.length, 6, 'STEM_ORDER is the six stems the page claims');
  assert.deepEqual(drawn, STEM_ORDER, 'the rail must draw one channel per stem, in STEM_ORDER');

  // a fader, a mute and a solo on EVERY channel, as real rendered nodes.
  //
  // Counting `>M<` across the whole document proves PRESENCE, not VISIBILITY, and not that
  // the node is the toggle: deleting the real `.pl-toggles` and leaving
  // `<span hidden>M</span><span hidden>S</span>` held the document-wide count at six with
  // both controls gone from the picture (adversarial sweep round 3, 2026-11-11; tsc exit 0,
  // suite unchanged at 926/906/0/20). So each letter has to be a `.pl-tog`, every `.pl-tog`
  // has to be visible, and the document may hold no spare `>M<` the toggles do not account
  // for. A `hidden` attribute is a deliberate act, unlike the `&nbsp;` of FG4 — but the gate
  // should not be the thing that misses it.
  const count = (re) => (html.match(re) ?? []).length;
  assert.equal(count(/class="pl-fader"/g), STEM_ORDER.length, 'every channel must draw a fader');
  for (const [label, letter] of [['mute', 'M'], ['solo', 'S']]) {
    const togs = [...html.matchAll(new RegExp(`<span class="pl-tog[^"]*"([^>]*)>${letter}</span>`, 'g'))];
    assert.equal(togs.length, STEM_ORDER.length, `every channel must draw a ${label} toggle as a .pl-tog`);
    for (const t of togs) {
      assert.doesNotMatch(t[1], /\bhidden\b|display:\s*none|visibility:\s*hidden/i,
        `a ${label} toggle is rendered but hidden: ${JSON.stringify(t[0])}`);
    }
    assert.equal(count(new RegExp(`>${letter}<`, 'g')), STEM_ORDER.length,
      `every >${letter}< in the page must BE a ${label} toggle — no spare copies elsewhere`);
  }
  // one of each per channel, not six on one channel
  for (const [i, chunk] of html.split(/(?=<div class="pl-ch[ "])/).slice(1).entries()) {
    const own = chunk.slice(0, chunk.indexOf('</div></div>') + 1 || undefined);
    for (const [label, letter] of [['mute', 'M'], ['solo', 'S']]) {
      assert.match(own, new RegExp(`<span class="pl-tog[^"]*"[^>]*>${letter}</span>`),
        `channel ${i} (${STEM_ORDER[i]}) must draw its own ${label} toggle`);
    }
  }

  // the chord ribbon, with chord names actually inside it
  const ribbon = html.match(/<div class="pl-chords">([\s\S]*?)<\/div>/);
  assert.ok(ribbon, 'the art must draw the chord ribbon');
  assert.ok((ribbon[1].match(/class="pl-chord[^"]*"/g) ?? []).length >= 2, 'the chord ribbon must carry chord names');

  // the section loop, and it must be a NAMED section, as SectionLoop.tsx renders one
  assert.match(html, /class="pl-loop"/, 'the art must draw the section loop');
  assert.match(html, /class="pl-loop-name[^"]*">[^<]+</, 'the section loop must be named');

  // and it must still say it is a drawing, not a recorded result
  assert.match(html, /<figcaption[^>]*>[\s\S]*?not a recorded result[\s\S]*?<\/figcaption>/i,
    'the figcaption must keep its honesty note');
});

test('drift is stated as a per-length upper bound, never zero', async () => {
  const src = readFileSync(join(WEB, 'src/components/landing/demo-data.ts'), 'utf8').replace(/^import .*$/m, 'const DEMO_DATA_BASE = "", DEMO_BEFORE_PEAKS_URL = "";');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { driftBoundMs } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  // FINDINGS v3: |drift| 0.9 / 1.8 / 0.6 / 5.7 ms at 1 / 2 / 4 / 8 bars
  const measured = { 1: 0.9, 2: 1.8, 4: 0.6, 8: 5.7 };
  for (const [bars, ms] of Object.entries(measured)) {
    const bound = driftBoundMs(+bars);
    assert.ok(bound > 0, `bound for ${bars} bars must not be zero`);
    assert.ok(bound > ms, `bound ${bound} ms must exceed the measured ${ms} ms at ${bars} bars`);
  }
});

test('the player art gets its three-column layout only at the wide breakpoint (1040px)', () => {
  // NOT a claim that the boxes fit — nothing in this suite can see a box. This gate holds the
  // ONE number that was wrong, so the next person has to re-measure before changing it.
  //
  // `.pl-band`'s 160px | 1fr | 340px rhythm puts 564px of FIXED width in a three-column grid,
  // so the middle track — the art — gets whatever is left. Introduced at 760px, that left 52px
  // for six channels. Measured in real Chromium against a production `next build` +
  // `next start`, 2026-11-11: at 760px the rail was 52px with 13px of overflow and every
  // channel at 0px, all six stem names clipped to nothing, the transport overflowing by 34px
  // and `.pl-loop` at width 0. It did not recover until about 1024px — the whole of iPad
  // portrait, split-view and any desktop window under ~1000px.
  //
  // 1040px is the page's own wide breakpoint (.hero-grid, .faq, .take). Below it the band
  // stacks, which measures clean down to 360px.
  const css = readFileSync(join(WEB, 'src/styles/landing.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  // Split into top-level text and @media blocks, so each rule knows the prelude it sits under.
  const blocks = [];
  for (let i = 0; i < css.length; ) {
    const at = css.indexOf('@media', i);
    if (at === -1) { blocks.push({ prelude: null, body: css.slice(i) }); break; }
    blocks.push({ prelude: null, body: css.slice(i, at) });
    const open = css.indexOf('{', at);
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    blocks.push({ prelude: css.slice(at + '@media'.length, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }

  const hits = [];
  for (const b of blocks) {
    for (const m of b.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|,)\s*\.pl-band\s*(,|$)/.test(m[1].trim())) continue;
      const g = m[2].match(/grid-template-columns\s*:\s*([^;]+)/);
      if (!g) continue;
      const tracks = g[1].trim().replace(/minmax\([^)]*\)/g, 'T').split(/\s+/).filter(Boolean).length;
      hits.push({ prelude: b.prelude, tracks, value: g[1].trim() });
    }
  }

  assert.ok(hits.some((h) => h.tracks === 1), '.pl-band must still have a one-column default');
  const multi = hits.filter((h) => h.tracks > 1);
  assert.equal(multi.length, 1, `expected exactly one multi-column .pl-band rule, saw ${multi.length}`);
  const min = multi[0].prelude && multi[0].prelude.match(/min-width\s*:\s*(\d+)px/);
  assert.ok(min, `the multi-column .pl-band rule must sit under a min-width media query, not ${JSON.stringify(multi[0].prelude)}`);
  assert.ok(
    Number(min[1]) >= 1040,
    `.pl-band gets ${multi[0].tracks} columns from ${min[1]}px. Below 1040px the art starves: ` +
      'measured 0px per channel and all six stem names clipped at 760px in Chrome. Re-measure at ' +
      '360/390/414/559/560/759/760/780/800/860/900/1024/1039/1040/1280 before lowering this.',
  );
});

test('the landing reads the v3 demo set', () => {
  const cfg = readFileSync(join(WEB, 'src/lib/public-config.ts'), 'utf8');
  assert.match(cfg, /'demo-assets-v3\/'/);
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
const ONE_TIME_LINK_CLAIMS = {
  'spec row': 'The one-time link by email only signs you back in to an account that already exists; it does not create one.',
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
  const blocks = { 'spec row': specRow('Account'), FAQ: faqAnswer('Do I need an account?') };
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
