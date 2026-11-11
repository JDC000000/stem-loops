// Landing copy gate: the demo's alignment claims must match the measured v3 demo
// (documents/stem-loops-landing/demo-assets-v3/FINDINGS.md), and claims that were never true
// (or describe the pre-tempo-fit pipeline) must not come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const LANDING = [...walk(join(WEB, 'src/app/(landing)')), ...walk(join(WEB, 'src/components/landing'))]
  .filter((p) => /\.(tsx?|css)$/.test(p))
  .map((p) => [p.slice(WEB.length + 1), readFileSync(p, 'utf8')]);

/**
 * Comments are not copy, and copy is not comments. Every positioning gate below runs over
 * COMMENT-STRIPPED source, because an adversarial sweep showed the previous gates could be
 * satisfied by a comment: delete every capability word from the visible page, drop
 * `// player faders mute solo chords` above the component, and the suite stayed green on a
 * page that had been reduced to a bare H1. Block comments go first; line comments only match
 * after start-of-line or whitespace, so `https://…` inside a string survives (the `//` there
 * is preceded by `:`).
 */
const decomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/**
 * The page and the components it owns, with comments stripped. NOT the whole landing: /terms
 * and /privacy are legal copy on their own review path, so these gates deliberately do not
 * police them and must not be read as a site-wide guarantee. As of 2026-11-11 those two pages
 * say an account is optional, which is TRUE of the shipped system — they need revisiting when
 * Story 1.5 actually lands, not before.
 */
const PAGE_AND_COMPONENTS = LANDING
  .filter(([f]) => !/\(landing\)\/(?:privacy|terms)\//.test(f))
  .map(([f, src]) => [f, decomment(src)]);

/** page.tsx alone, comments stripped. */
const PAGE = PAGE_AND_COMPONENTS.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];

/** The one ceiling. Read from the module the player enforces, so the test cannot drift either. */
const MAX_TRACK_SEC = Number(
  readFileSync(join(WEB, 'src/lib/play/types.ts'), 'utf8').match(/export const MAX_TRACK_SEC = ([\d_]+)/)[1].replace(/_/g, ''),
);
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

/** Pull one <dd> out of the scope sheet by its <dt>. */
const specRow = (dt) => {
  const m = PAGE.match(new RegExp(`<dt>${dt}</dt>\\s*<dd>([\\s\\S]*?)</dd>`));
  assert.ok(m, `the scope sheet has no "${dt}" row`);
  return m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;|\s+/g, ' ').trim();
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

test('the landing never claims "no account" — sign-in is required from launch (Story 1.5)', () => {
  // Positive first — "Account: Optional — you can start a job straight away" passed the ban
  // list on its own (adversarial sweep, 2026-11-11).
  assert.match(specRow('Account'), /^Required\./);
  const banned = [/no account/i, /without an account/i, /needs no account/i, /no accounts/i, /no sign.?up/i,
    /account (?:is )?optional/i, /\boptional\b[^.]{0,20}account/i, /not required/i, /without signing in/i,
    /no sign.?in/i, /start(?: a job)? (?:straight|right) away/i];
  for (const [file, src] of PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the landing shows no price, plan or paywall — there is no payment at launch', () => {
  const banned = [/\$\d/, /\bper month\b/i, /\/mo\b/, /\bfree forever\b/i, /\bupgrade\b/i, /\bpricing\b/i, /\bpaid plan/i, /\bcredits\b/i];
  for (const [file, src] of PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the landing never links to /pricing', () => {
  for (const [file, src] of PAGE_AND_COMPONENTS) assert.doesNotMatch(src, /href="\/pricing/, `${file} links /pricing`);
});

test('the landing claims no mobile or non-Chrome support (Story 5.3)', () => {
  // Positive first: the row has to SAY the scope. A ban list alone let "Chrome, and it runs
  // fine on a tablet or a handset too" through (adversarial sweep, 2026-11-11).
  assert.match(specRow('Where it runs'), /^Chrome, on a desktop\./);
  assert.match(specRow('Where it runs'), /not supported yet/);
  const banned = [/works on (?:your |a )?(?:phone|mobile|ios|android|tablet|handset)/i, /\bany browser\b/i, /\bevery browser\b/i,
    /mobile.friendly/i, /runs? (?:fine |well |great )?on (?:a )?(?:tablet|handset|phone|mobile)/i, /(?:tablet|handset|phone)s? (?:too|as well)\b/i];
  for (const [file, src] of PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the landing says tempo and pitch are coming, and never implies we have them', () => {
  const page = LANDING.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];
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
  for (const [file, src] of PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  // lyrics are out of scope (not "coming"), and the page says so in its own row
  const lyrics = page.match(/<dt>Lyrics<\/dt>\s*<dd>([^<]*)/);
  assert.ok(lyrics, 'no <dd> for the Lyrics row');
  assert.match(lyrics[1], /^No\./, `the Lyrics row must open with "No." — got ${JSON.stringify(lyrics[1].slice(0, 40))}`);
});

test('the landing invents no social proof — production has zero registered users', () => {
  const banned = [/\btestimonial/i, /\d[\d,.]*\s*(?:\+\s*)?(?:happy\s+)?(?:users|musicians|players|customers|members)\b/i,
    /\bloved by\b/i, /\btrusted by\b/i, /\bas seen (?:in|on)\b/i, /\b\d(?:\.\d)?\s*\/\s*5\b/, /\bstars?\b/i, /\breviews?\b/i, /\bjoin \d/i];
  for (const [file, src] of PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
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
  for (const [file, src] of PAGE_AND_COMPONENTS) {
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
});

test('the page claims no submit-time length gate — nothing enforces one', () => {
  // F4: the web layer caps BYTES only (200 MB) and the worker's MAX_UPLOAD_DURATION_SEC
  // defaults to 600 s, not 300. The 300 s ceiling lives in the player's engine and in
  // Klangio. An over-length track is accepted and separated at real cost, so the page must
  // not promise it is turned away at the door.
  const banned = [/\brefused\b/i, /\brejected\b/i, /\bturned away\b/i, /\bwon't be accepted\b/i, /\bwe'll stop you\b/i];
  for (const [file, src] of PAGE_AND_COMPONENTS) for (const re of banned) assert.doesNotMatch(src, re, `${file} claims a gate that does not exist (${re})`);
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
});

test('the drawing shows what the copy claims — the art and the page cannot drift apart', () => {
  // The page says six faders with a mute and a solo, a chord track and a section loop. If
  // PlayerArt stops drawing any of that, the page is claiming something its own illustration
  // contradicts — which stayed green until this gate existed (adversarial sweep, 2026-11-11).
  const art = PAGE_AND_COMPONENTS.find(([f]) => f.endsWith('landing/PlayerArt.tsx'));
  assert.ok(art, 'PlayerArt.tsx is missing');
  const src = art[1];
  assert.match(src, /STEM_ORDER\.map/, 'the rail must be built from STEM_ORDER, so it is six channels');
  assert.match(src, />M</, 'the art must draw a mute toggle');
  assert.match(src, />S</, 'the art must draw a solo toggle');
  assert.match(src, /pl-fader/, 'the art must draw faders');
  assert.match(src, /pl-chords/, 'the art must draw the chord ribbon');
  assert.match(src, /pl-loop/, 'the art must draw the section loop');
  // and it must still say it is a drawing, not a recorded result
  assert.match(src, /not a recorded result/i, 'the figcaption must keep its honesty note');
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

test('the landing reads the v3 demo set', () => {
  const cfg = readFileSync(join(WEB, 'src/lib/public-config.ts'), 'utf8');
  assert.match(cfg, /'demo-assets-v3\/'/);
  assert.match(cfg, /'assets-v3\/'/);
  assert.match(cfg, /lucky_ticket_drums_102\.0bpm_G_minor_verse_0006\.wav/);
});
