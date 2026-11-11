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

// The marketing surface: the landing page and the components it owns. /terms and /privacy are
// legal copy with their own review path, so the positioning gates below do not police them —
// a contradiction there is a finding for a human, not something a test should silently pin.
const MARKETING = LANDING.filter(([f]) => !/\(landing\)\/(?:privacy|terms)\//.test(f));

test('no pre-tempo-fit numbers or never-true claims in the landing', () => {
  const banned = [
    /\b31\s*(?:&nbsp;|\\u00a0| )?ms/i, /\b62\s*(?:&nbsp;|\\u00a0| )?ms/i, /\b124\s*(?:&nbsp;|\\u00a0| )?ms/i,
    /20 ms after/i, /repeats? (?:run|runs) long/i, /time.stretch/i, /101\.3/, /cut to the bar/i,
    /starts on the downbeat/i, /no drift/i, /zero drift/i, /drift-free/i, /phase-locked/i, /sample-accurate/i,
  ];
  for (const [file, src] of LANDING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the H1 stays "Paste a song. Play along."', () => {
  const page = LANDING.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];
  assert.match(page, /Paste a song\.<\/span> <span className="h1-line">Play along\./);
});

// ── Story 0 (2026-11-11): the landing sells the play-along product. These gates exist so
// the loop-downloader positioning, and the binding facts it contradicted, cannot come back.

test('the landing never claims "no account" — sign-in is required from launch (Story 1.5)', () => {
  const banned = [/no account/i, /without an account/i, /needs no account/i, /no accounts/i, /no sign.?up/i];
  for (const [file, src] of MARKETING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the landing shows no price, plan or paywall — there is no payment at launch', () => {
  const banned = [/\$\d/, /\bper month\b/i, /\/mo\b/, /\bfree forever\b/i, /\bupgrade\b/i, /\bpricing\b/i, /\bpaid plan/i, /\bcredits\b/i];
  for (const [file, src] of MARKETING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the landing never links to /pricing', () => {
  for (const [file, src] of MARKETING) assert.doesNotMatch(src, /href="\/pricing/, `${file} links /pricing`);
});

test('the landing claims no mobile or non-Chrome support (Story 5.3)', () => {
  const page = LANDING.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];
  assert.match(page, /Chrome/);
  const banned = [/works on (?:your )?(?:phone|mobile|ios|android)/i, /\bany browser\b/i, /\bevery browser\b/i, /mobile.friendly/i];
  for (const [file, src] of MARKETING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
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
  for (const [file, src] of MARKETING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
  // lyrics are out of scope (not "coming"), and the page says so in its own row
  const lyrics = page.match(/<dt>Lyrics<\/dt>\s*<dd>([^<]*)/);
  assert.ok(lyrics, 'no <dd> for the Lyrics row');
  assert.match(lyrics[1], /^No\./, `the Lyrics row must open with "No." — got ${JSON.stringify(lyrics[1].slice(0, 40))}`);
});

test('the landing invents no social proof — production has zero registered users', () => {
  const banned = [/\btestimonial/i, /\d[\d,.]*\s*(?:\+\s*)?(?:happy\s+)?(?:users|musicians|players|customers|members)\b/i,
    /\bloved by\b/i, /\btrusted by\b/i, /\bas seen (?:in|on)\b/i, /\b\d(?:\.\d)?\s*\/\s*5\b/, /\bstars?\b/i, /\breviews?\b/i, /\bjoin \d/i];
  for (const [file, src] of MARKETING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the track-length copy is derived from MAX_TRACK_SEC, not typed in', async () => {
  const page = LANDING.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];
  assert.match(page, /import \{ MAX_TRACK_SEC \} from '@\/lib\/play\/types'/);
  assert.match(page, /MAX_TRACK_MIN = Math\.floor\(MAX_TRACK_SEC \/ 60\)/);
  // no hard-coded minute figure anywhere in the landing
  for (const [file, src] of MARKETING) assert.doesNotMatch(src, /\b(?:five|5)\s*(?:&nbsp;|\\u00a0| )?minutes?\b/i, `${file} hard-codes the cap`);
});

test('the page itself names the player, the faders, mute, solo, the chords and the loop', () => {
  // Asserted against page.tsx, not the whole landing: an earlier version joined every landing
  // file, so the words surviving in PlayerArt.tsx alone let the page lose them all (mutation
  // check, 2026-11-11). Every one of these is a row of the approved launch capability table.
  const page = LANDING.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];
  for (const re of [/\bplayer\b/i, /\bfaders?\b/i, /\bmute\b/i, /\bsolo\b/i, /\bchords?\b/i, /section of the song/i, /six stems|<dd>Six —/i]) {
    assert.match(page, re, `the landing page never says ${re}`);
  }
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
