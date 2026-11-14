// SEO-05: the home page's one JSON-LD block, rendered through the landing render helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from './helpers/render-landing-page.mjs';
import { compile } from './helpers/render-chrome.mjs';
import { ENTITY_ONE_LINER, MAX_TRACK_MIN } from '../src/lib/seo/site.ts';
import { pageFor } from '../src/lib/seo/pages.ts';
import { MAX_TRACK_SEC } from '../src/lib/play/types.ts';

const page = await renderPage('app/(landing)/page.tsx');
const blocks = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('exactly one JSON-LD block, and it parses', () => {
  assert.equal(blocks.length, 1);
  JSON.parse(blocks[0]);
});

test('entity facts come from the shared constants', () => {
  const g = JSON.parse(blocks[0])['@graph'];
  const app = g.find((n) => n['@type'] === 'WebApplication');
  assert.equal(app.description, ENTITY_ONE_LINER);
  assert.ok(app.featureList.includes(`Uses the first ${MAX_TRACK_MIN} minutes of any song`));
  // Story 2.1 stem order, everywhere.
  assert.ok(app.featureList.includes('Six stems: drums, bass, guitar, keys, vocals and other'));
  assert.ok(app.featureList.includes('Files deleted after 24 hours'));
  assert.match(app.browserRequirements, /Chrome on a desktop/);
  assert.equal(app.offers.price, '0');
  assert.match(ENTITY_ONE_LINER, /\bsix stems\b/);
});

test('no ratings or reviews, no YouTube, no empty sameAs, no Person until /about is published', () => {
  const raw = blocks[0];
  assert.doesNotMatch(raw, /aggregateRating|"review"|ratingValue/);
  assert.doesNotMatch(raw, /youtube/i);
  assert.doesNotMatch(raw, /"sameAs":\[\]/);
  const about = pageFor('/about');
  if (!about?.published) assert.doesNotMatch(raw, /"Person"|about#jon/);
});

test('the home meta description is the registry entry for "/" (one source, built from MAX_TRACK_MIN)', async () => {
  const [url] = compile(['app/(landing)/page.tsx']);
  const mod = await import(url);
  assert.equal(mod.metadata.description, pageFor('/').description);
  assert.ok(pageFor('/').description.includes(`${MAX_TRACK_MIN} minutes`));
});

test('the SEO minute figure is the player cap', () => {
  assert.equal(MAX_TRACK_MIN, Math.floor(MAX_TRACK_SEC / 60));
  assert.ok(pageFor('/').description.includes(`${Math.floor(MAX_TRACK_SEC / 60)} minutes`));
});

test('#270: a longer song is trimmed, not refused, so no SEO text says "up to N minutes"', () => {
  // 2026-11-14 (Jon): songs over the cap are trimmed to their first MAX_TRACK_MIN minutes. "Up to"
  // reads as a ceiling that turns longer songs away; the SEO copy matches the landing instead.
  const texts = [['JSON-LD', blocks[0]], ...['/', '/privacy', '/terms'].map((p) => [`registry ${p}`, pageFor(p).description])];
  for (const [where, text] of texts) {
    assert.doesNotMatch(text, /\bup to\s+\d+\s*minutes?\b/i, `${where} says "up to N minutes"`);
    assert.doesNotMatch(text, /\btracks up to\b/i, `${where} says "tracks up to"`);
  }
  assert.ok(pageFor('/').description.includes(`Uses the first ${MAX_TRACK_MIN} minutes of any song.`));
});

test('JsonLd escapes every "<" so a string in the data can never close the script tag', async () => {
  // Pins the `.replace(/</g, '\\u003c')` in components/seo/JsonLd.tsx (Opus review of #271: the one
  // surviving mutant). Without it, "</script><script>…" in any field would end the block early.
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [url] = compile(['components/seo/JsonLd.tsx']);
  const { JsonLd } = await import(url);
  const evil = '</script><script>alert(1)</script><!--';
  const html = renderToStaticMarkup(React.createElement(JsonLd, { data: { name: evil } }));
  const inner = html.match(/^<script type="application\/ld\+json">([\s\S]*)<\/script>$/);
  assert.ok(inner, `exactly one script element, closed once at the end: ${html}`);
  assert.doesNotMatch(inner[1], /</, 'no raw "<" inside the block');
  assert.ok(inner[1].includes('\\u003c/script>'), '"<" is serialised as \\u003c');
  assert.equal(JSON.parse(inner[1]).name, evil, 'the escaped JSON still parses back to the original string');
  // and the real home block carries no raw "<" either
  assert.doesNotMatch(blocks[0], /</);
});
