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
const soon = () => HOME.html.match(/<p class="wyg-soon"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';

test('"What you get" is the six true-today lines, in order, and about 70 words with "Coming soon"', () => {
  const lines = [...wyg().matchAll(/<li data-line="([^"]+)">([\s\S]*?)<\/li>/g)].map((m) => [m[1], flatten(m[2])]);
  assert.deepEqual(lines, [
    ['stems', '6 stems — drums, bass, guitar, keys, vocals, other. Mute any of them.'],
    ['chords', 'Chords in time with the song. Auto-detected, so trust your ear.'],
    ['loop', 'Loop any section — or several in a row.'],
    ['length', 'First 5 minutes of each song.'],
    ['device', 'Best in Chrome on a computer. Phones work too, with lighter audio; phone support is new.'],
    ['account', 'Free account needed to play.'],
  ]);
  const n = words(flatten(wyg())) + words(flatten(soon()));
  assert.ok(n >= 55 && n <= 80, `"What you get" + "Coming soon" is ${n} words; P7 asks for ~70`);
  // The old 8-row scope sheet is gone.
  assert.doesNotMatch(HOME.html, /class="spec"|<dt>Where it runs<\/dt>|<dt>Track length<\/dt>/);
});

test('DB-17: the Chords line is decided by ONE constant, and turning it off drops only that line', async () => {
  const src = readFileSync(join(WEB, 'src/lib/chords-claim.ts'), 'utf8');
  assert.equal((src.match(/export const CHORDS_LINE_SHOWN = (true|false);/g) ?? []).length, 1);
  assert.match(src, /DB-17/, 'the switch says why it exists');
  // Nobody else defines it: every consumer imports this one.
  for (const f of ['src/components/landing/what-you-get.ts', 'src/app/(landing)/page.tsx', 'src/components/landing/PlayerArt.tsx',
    'src/components/landing/faq.tsx', 'src/lib/seo/pages.ts', 'src/lib/seo/jsonld.ts', 'src/lib/seo/site.ts',
    // QA C-12 (2026-11-18): the rest of the site reads the same switch.
    'src/lib/seo/llms.ts', 'src/app/(landing)/terms/page.tsx', 'src/app/(landing)/privacy/page.tsx',
    'src/lib/emails/templates/welcome.ts', 'src/app/loops/LoopsView.tsx']) {
    const t = readFileSync(join(WEB, f), 'utf8');
    assert.doesNotMatch(t, /const CHORDS_LINE_SHOWN\s*=/, `${f} defines its own switch`);
    assert.match(t, /import \{[^}]*\bCHORDS_LINE_SHOWN\b[^}]*\} from '(?:@\/lib\/chords-claim|\.\.\/chords-claim\.ts)'/, `${f} does not read the switch`);
  }
  const wygSrc = readFileSync(join(WEB, 'src/components/landing/what-you-get.ts'), 'utf8');
  const load = async (flag) => {
    const js = ts.transpileModule(
      wygSrc.replace(/import \{ MAX_TRACK_SEC \} from '@\/lib\/play\/types';/, 'const MAX_TRACK_SEC = 300;')
        .replace(/import \{ CHORDS_LINE_SHOWN \} from '@\/lib\/chords-claim';/, `const CHORDS_LINE_SHOWN = ${flag};`),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64') + '#' + flag);
  };
  const on = (await load(true)).WHAT_YOU_GET.map((l) => l.key);
  const off = (await load(false)).WHAT_YOU_GET.map((l) => l.key);
  assert.deepEqual(on, ['stems', 'chords', 'loop', 'length', 'device', 'account']);
  assert.deepEqual(off, ['stems', 'loop', 'length', 'device', 'account']);
});

// SF-3 (review round 2): flipping the switch alone must leave NO chord claim on the home page —
// not just the "What you get" line. Rendered (the repo's rule), with the switch patched to false
// at its one definition, then every channel the render helper exposes is searched: DOM text in
// both normalisations, accessible-name attributes, the page metadata, and the JSON-LD script.
const OFF = await renderPage('app/(landing)/page.tsx', {
  patch: (rel, src) => (rel === join('lib', 'chords-claim.ts')
    ? src.replace(/export const CHORDS_LINE_SHOWN = true;/, 'export const CHORDS_LINE_SHOWN = false;')
    : src),
});
// QA C-12 (2026-11-18): the Open Graph IMAGE and its alt text are switched too (OG_IMAGE and
// OG_ALT in lib/seo/site.ts), so with the switch off the metadata has NO allowed chord mention.
// The off-image is v3 (stems and a boxed loop): its alt is expected, and the v4 file must be gone.
const OG_V3_ALT = 'Waveforms for four stems, drums, bass, vocals and guitar, with a four-bar loop boxed, under the headline Paste a song. Get bar-length loops.';

test('SF-3: CHORDS_LINE_SHOWN=false removes EVERY chord claim from the rendered home page', () => {
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
  assert.match(OFF.textSpaced, /Six stems on faders\. Turn your part down and play it yourself\./);
  assert.match(OFF.textSpaced, /the six stems on faders, and a loop you can set on any detected section/);
  assert.match(OFF.textSpaced, /trimmed on our end, where the player stops\./);
  assert.match(OFF.textSpaced, /The stems load into the player\. Pull your part down/);
  const qs = [...OFF.html.match(/<section[^>]*id="faq"[\s\S]*?<\/section>/)[0].matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.deepEqual(qs.length, 4);
  // And with it on, the default render is unchanged: the chords lines are all there.
  for (const re of [/with the chords running over the top/, /the chords across the top/, /where the chord track and the player both stop/,
    /with the chord track over them/, /Chords An estimate, kept in time with the song/, /How good are the chords\?/]) {
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
