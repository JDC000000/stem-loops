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
  const src = readFileSync(join(WEB, 'src/components/landing/what-you-get.ts'), 'utf8');
  assert.equal((src.match(/export const CHORDS_LINE_SHOWN = (true|false);/g) ?? []).length, 1);
  assert.match(src, /DB-17/, 'the switch says why it exists');
  const load = async (flag) => {
    const js = ts.transpileModule(
      src.replace(/import \{ MAX_TRACK_SEC \} from '@\/lib\/play\/types';/, 'const MAX_TRACK_SEC = 300;')
        .replace(/CHORDS_LINE_SHOWN = true;/, `CHORDS_LINE_SHOWN = ${flag};`),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64') + '#' + flag);
  };
  const on = (await load(true)).WHAT_YOU_GET.map((l) => l.key);
  const off = (await load(false)).WHAT_YOU_GET.map((l) => l.key);
  assert.deepEqual(on, ['stems', 'chords', 'loop', 'length', 'device', 'account']);
  assert.deepEqual(off, ['stems', 'loop', 'length', 'device', 'account']);
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
