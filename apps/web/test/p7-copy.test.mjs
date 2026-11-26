// Design v1.4, P7 ("Too much copy"), Slice 1b. Pins, on RENDERED output (the repo's rule:
// test/helpers/render-landing-page.mjs), the parts of P7 that shipped:
//   - "What you get": about 70 words, the six true-today lines, the DB-17 Chords switch;
//   - home FAQ ≤ 5, every answer on /help, /help indexable and in the sitemap;
//   - no implementation names on user-facing pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { landingPage, renderPage } from './helpers/render-landing-page.mjs';
import sitemap from '../src/app/sitemap.ts';
import { pageFor } from '../src/lib/seo/pages.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const flatten = (s) => s.replace(/<[^>]*>/g, ' ').replace(/[\s ]+/g, ' ').trim();
const words = (s) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

const HOME = await landingPage();
const HELP = await renderPage('app/(landing)/help/page.tsx');
const TERMS = await renderPage('app/(landing)/terms/page.tsx');

const wyg = () => HOME.html.match(/<ul class="wyg"[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? '';
// The FAQ section only: the hero's example has its own <details> ("How to read this").
const homeFaq = () => HOME.html.match(/<section[^>]*id="faq"[\s\S]*?<\/section>/)?.[0] ?? '';
const more = () => HOME.html.match(/<p class="wyg-more"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';

test('"What you get" is three true-today proof points, in order, short, with the ⋯ menu line (A4 home page diet; QW-4)', () => {
  const lines = [...wyg().matchAll(/<li data-line="([^"]+)">([\s\S]*?)<\/li>/g)].map((m) => [m[1], flatten(m[2])]);
  assert.deepEqual(lines, [
    ['chords', 'Chords in time with the song, with the next one shown. Auto-detected, so trust your ear.'],
    ['stems', '6 stems — drums, bass, guitar, keys, vocals, other. Turn your part down, mute it or solo it.'],
    ['loop', 'Loop any section — or several in a row.'],
  ]);
  const n = words(flatten(wyg())) + words(flatten(more()));
  assert.ok(n >= 25 && n <= 60, `"What you get" + the ⋯ menu line is ${n} words; three one-liners`);
  // The old 8-row scope sheet is gone, and so is the desktop-first device line.
  assert.doesNotMatch(HOME.html, /class="spec"|<dt>Where it runs<\/dt>|<dt>Track length<\/dt>|Best in Chrome on a computer/);
});

test('DB-17: the chord claims hang on ONE runtime switch, read from CHORDS_CLAIMS, default ON', async () => {
  const src = readFileSync(join(WEB, 'src/lib/chords-claim.ts'), 'utf8');
  assert.match(src, /DB-17/, 'the switch says why it exists');
  assert.doesNotMatch(src, /export const CHORDS_LINE_SHOWN/, 'the old build-time constant is gone');
  const { parseChordsClaims, chordsLineShown, CHORDS_CLAIMS_ENV } = await import('../src/lib/chords-claim.ts');
  assert.equal(CHORDS_CLAIMS_ENV, 'CHORDS_CLAIMS');
  for (const v of [undefined, null, '', 'on', 'true', '1', 'yes', 'ON', 'of', 'disabled']) assert.equal(parseChordsClaims(v), true, `${v} must leave the claims ON`);
  for (const v of ['off', 'OFF', ' Off ', 'false', '0', 'no']) assert.equal(parseChordsClaims(v), false, `${v} must turn the claims OFF`);
  // Read at CALL time, not module load: flipping the variable flips the next read.
  const before = process.env.CHORDS_CLAIMS;
  try {
    delete process.env.CHORDS_CLAIMS;
    assert.equal(chordsLineShown(), true);
    process.env.CHORDS_CLAIMS = 'off';
    assert.equal(chordsLineShown(), false);
    process.env.CHORDS_CLAIMS = 'on';
    assert.equal(chordsLineShown(), true);
  } finally {
    if (before === undefined) delete process.env.CHORDS_CLAIMS; else process.env.CHORDS_CLAIMS = before;
  }
  // Nobody defines a switch of their own: server modules import chordsLineShown, and the two
  // client components take it as a prop from the server page that renders them.
  for (const f of ['src/app/(landing)/page.tsx', 'src/components/landing/faq.tsx', 'src/lib/seo/pages.ts', 'src/lib/seo/jsonld.ts',
    'src/lib/seo/site.ts', 'src/lib/seo/llms.ts', 'src/app/(landing)/terms/page.tsx', 'src/app/(landing)/privacy/page.tsx',
    'src/lib/emails/templates/welcome.ts', 'src/app/loops/page.tsx']) {
    const t = readFileSync(join(WEB, f), 'utf8');
    assert.match(t, /import \{[^}]*\bchordsLineShown\b[^}]*\} from '(?:@\/lib\/chords-claim|\.\.\/chords-claim\.ts)'/, `${f} does not read the switch`);
  }
  assert.match(readFileSync(join(WEB, 'src/app/(landing)/page.tsx'), 'utf8'), /<HomeDemo chordsShown=\{chords\} \/>/);
  assert.match(readFileSync(join(WEB, 'src/app/loops/page.tsx'), 'utf8'), /chordsShown=\{chordsLineShown\(\)\}/);
  // PR #332 round 2: the claim pages stay STATIC and CDN-cached. The switch is read when they are
  // BUILT, and the Redeploy a Vercel env change needs rebuilds them (lib/chords-claim.ts). So no
  // claim page opts out of static rendering, and llms.txt is force-static.
  for (const f of ['src/app/(landing)/page.tsx', 'src/app/(landing)/help/page.tsx', 'src/app/(landing)/terms/page.tsx',
    'src/app/(landing)/privacy/page.tsx']) {
    assert.doesNotMatch(readFileSync(join(WEB, f), 'utf8'), /export const dynamic\b/, `${f} opts out of static rendering (and CDN caching)`);
  }
  assert.match(readFileSync(join(WEB, 'src/app/llms.txt/route.ts'), 'utf8'), /export const dynamic = 'force-static';/);
  const { whatYouGet } = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(
    readFileSync(join(WEB, 'src/components/landing/what-you-get.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64'));
  assert.deepEqual(whatYouGet(true).map((l) => l.key), ['chords', 'stems', 'loop']);
  assert.deepEqual(whatYouGet(false).map((l) => l.key), ['stems', 'loop', 'phone']);
});

// SF-3 (review round 2): flipping the switch alone must leave NO chord claim on the home page —
// not just the "What you get" line. Rendered (the repo's rule), with CHORDS_CLAIMS=off in the
// environment for the render (the runtime switch, A4), then every channel the render helper
// exposes is searched: DOM text in both normalisations, accessible-name attributes, the page
// metadata, and the JSON-LD script.
const OFF = await renderPage('app/(landing)/page.tsx', { env: { CHORDS_CLAIMS: 'off' } });
// QA C-12 (2026-11-18): the Open Graph IMAGE and its alt text are switched too (OG_IMAGE and
// OG_ALT in lib/seo/site.ts), so with the switch off the metadata has NO allowed chord mention.
// The off-image is v3 (stems and a boxed loop): its alt is expected, and the v4 file must be gone.
const OG_V3_ALT = 'Waveforms for four stems, drums, bass, vocals and guitar, with a four-bar loop boxed, under the headline Paste a song. Get bar-length loops.';

test('SF-3: CHORDS_CLAIMS=off removes EVERY chord claim from the rendered home page', () => {
  assert.ok(/chord/i.test(HOME.textSpaced), 'sanity: with the switch on, the page does talk about chords');
  for (const [where, text] of [['text (spaced)', OFF.textSpaced], ['text (tight)', OFF.textTight]]) {
    const hits = text.match(/.{0,50}chord.{0,50}/gi) ?? [];
    assert.deepEqual(hits, [], `${where} still claims chords`);
  }
  for (const [where, text] of [['metadata (spaced)', OFF.metaSpaced], ['metadata (tight)', OFF.metaTight]]) {
    assert.deepEqual(text.match(/.{0,50}chord.{0,50}/gi) ?? [], [], `${where} still claims chords`);
    assert.doesNotMatch(text, /og-image-v4/, `${where} still shares the image that draws chord names`);
  }
  assert.ok(OFF.metaSpaced.includes('/og-image-v3.png'), 'the off-image is v3');
  assert.ok(OFF.metaSpaced.includes(OG_V3_ALT), 'the off-image carries its own alt text');
  const jsonLd = [...OFF.html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  assert.ok(jsonLd.length > 0, 'the home page renders its JSON-LD');
  assert.doesNotMatch(jsonLd, /chord/i, 'the JSON-LD still claims chords');
  // Visible markup other than CSS class names (e.g. the drawn player's `pl-chord`, now gone too).
  assert.doesNotMatch(OFF.html.replace(/<script[\s\S]*?<\/script>/gi, ''), /chord/i, 'chords left in the markup');
});

test('SF-3: with the switch off, the rest of the page is intact', () => {
  assert.match(OFF.textSpaced, /Every part on its own fader, on your phone or your computer\./);
  assert.match(OFF.textSpaced, /The real player: mute any part, loop a section\./);
  assert.match(OFF.textSpaced, /On your phone or your computer\. Phones load lighter audio so all six stems fit\./);
  const qs = [...OFF.html.match(/<section[^>]*id="faq"[\s\S]*?<\/section>/)[0].matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.deepEqual(qs.length, 4);
  // And with it on, the default render is unchanged: the chords lines are all there.
  for (const re of [/The chords in time and every part on its own fader/, /The real player: chords in time/,
    /Chords in time with the song, with the next one shown/, /How good are the chords\?/]) {
    assert.match(HOME.textSpaced, re);
  }
});

test('home FAQ is at most five questions and links to /help', () => {
  const qs = [...homeFaq().matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.ok(qs.length <= 5, `home FAQ has ${qs.length} questions`);
  assert.ok(qs.length >= 3, 'the home FAQ is still there');
  assert.match(homeFaq(), /<a href="\/help">More questions and answers →<\/a>/);
});

test('/help carries every question, the home five included, each exactly once', () => {
  const help = [...HELP.html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.equal(new Set(help).size, help.length, 'a question appears twice on /help');
  for (const q of [...homeFaq().matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1])) {
    assert.ok(help.includes(q), `/help is missing the home question "${q}"`);
  }
  for (const q of ['Which browsers work?', 'How clean is the split?', 'Can I use the stems in my own music?', 'What do I actually get?']) {
    assert.ok(help.includes(q), `/help is missing "${q}"`);
  }
  assert.match(HELP.html, /<h1>Help<\/h1>/);
});

test('#379 item 3: /help notes the pickup-song limit, under Playing along, in plain words', () => {
  const LINE = 'Songs that start with a pickup (a few notes before the first full bar) may show bar 1 a beat or two early; the chords still follow the music.';
  assert.ok(flatten(HELP.html).includes(LINE), '/help is missing the pickup line');
  assert.doesNotMatch(HELP.textSpaced, /anacrusis/i, 'no jargon on /help');
  // Under "Playing along": after that heading and before the next one.
  const playing = HELP.html.split(/<h2[^>]*>/).find((part) => part.startsWith('Playing along'));
  assert.ok(playing && /<details id="faq-pickup">/.test(playing), 'the pickup answer is not under Playing along');
  assert.doesNotMatch(homeFaq(), /faq-pickup/, 'the pickup answer is /help only');
  // With CHORDS_CLAIMS=off it leaves with the chords: pinned by chords-switch-surfaces.test.mjs (C-12 /help).
});

test('/help is public, indexable and in the sitemap; the footer links it', () => {
  const p = pageFor('/help');
  assert.ok(p && p.published, '/help is in the registry and published');
  assert.ok(sitemap().some((e) => e.url === 'https://stem-loops.com/help'), '/help is in sitemap.xml');
  assert.doesNotMatch(HELP.html, /noindex/);
  assert.match(HOME.html, /<footer[\s\S]*<a href="\/help">Help<\/a>[\s\S]*<\/footer>/);
});

test('no implementation names on the home page, /help, /terms or in the footer', () => {
  const NAMES = /demucs|htdemucs|replicate|klangio|\bmono\b|\b24\s*kHz\b/i;
  for (const [where, page] of [['home', HOME], ['/help', HELP], ['/terms', TERMS]]) {
    for (const t of [page.textSpaced, page.textTight, page.metaSpaced]) assert.doesNotMatch(t, NAMES, where);
  }
});
