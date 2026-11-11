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
test('the landing never claims an account is required to START — nothing enforces one', () => {
  // Positive first, for the same reason the old polarity led with one: a ban list alone let
  // "Account: Required." stand with a qualifier appended further down the row. The prefix is
  // the verdict the reader gets before any qualifier, and it stays a PREFIX assertion so the
  // decomment precondition documented above still holds.
  assert.match(specRow('Account'), /^Needed to play, not to start\./);
  // …and the row must still carry the half that IS true, so inverting the gate cannot be
  // satisfied by a page that simply stops mentioning sign-in at all.
  assert.match(specRow('Account'), /sign in/i);

  // Scoped to the START claim. "You need an account to open the player" is TRUE and must not
  // be banned, so none of these fire on it.
  const banned = [
    /you need an account\s*[.!]/i,            // the old hero sentence, verbatim
    /required\.\s*sign in/i,                  // the old scope-sheet row, verbatim
    /account (?:is )?required to (?:start|use|paste|submit|run)/i,
    /(?:an account|sign.?in|sign.?up) (?:is )?required (?:to (?:start|use|paste|submit|run)|before)/i,
    /needs? an account (?:to|before) (?:start|paste|submit|run|use)/i,
    /must (?:sign|log) in (?:to|before) (?:start|paste|submit|run|use)/i,
    /sign up (?:first|to start)/i,
    /no (?:job|jobs) without an account/i,
  ];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
});

test('the landing shows no price, plan or paywall — there is no payment at launch', () => {
  const banned = [/\$\d/, /\bper month\b/i, /\/mo\b/, /\bfree forever\b/i, /\bupgrade\b/i, /\bpricing\b/i, /\bpaid plan/i, /\bcredits\b/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} says ${re}`);
});

test('the landing never links to /pricing', () => {
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) assert.doesNotMatch(src, /href="\/pricing/, `${file} links /pricing`);
  assert.doesNotMatch(RENDER.html, /href="\/pricing/, 'the rendered page links /pricing');
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

test('the page claims no submit-time length gate — nothing enforces one', () => {
  // F4: the web layer caps BYTES only (200 MB) and the worker's MAX_UPLOAD_DURATION_SEC
  // defaults to 600 s, not 300. The 300 s ceiling lives in the player's engine and in
  // Klangio. An over-length track is accepted and separated at real cost, so the page must
  // not promise it is turned away at the door.
  const banned = [/\brefused\b/i, /\brejected\b/i, /\bturned away\b/i, /\bwon't be accepted\b/i, /\bwe'll stop you\b/i];
  for (const [file, src] of RAW_PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} claims a gate that does not exist (${re})`);
  for (const [where, text] of READ_AS) for (const re of banned) assert.doesNotMatch(text, re, `${where} claims a gate that does not exist (${re})`);
  assert.match(specRow('Track length'), /not supported/i);
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
