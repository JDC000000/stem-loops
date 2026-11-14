// SEO-04 / SEO-06: the page registry and the metadata it produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PAGES } from '../src/lib/seo/pages.ts';
import { pageMetadata } from '../src/lib/seo/meta.ts';
import { compile } from './helpers/render-chrome.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');
const BANNED = [/!/, /\bclick/i, /\bdrop\b/i, /\bhover/i, /\bextract/i, /\baccurate\b/i, /\bperfect\b/i, /studio-quality/i, /\binstantly\b/i, /\bunlimited\b/i, /youtube/i];

// Every page.tsx under app/, as its URL path (route groups dropped) and its src-relative file.
function routes() {
  const out = [];
  (function walk(dir, url, rel) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const group = /^\(.*\)$/.test(e.name);
        walk(join(dir, e.name), group ? url : `${url}/${e.name}`, `${rel}/${e.name}`);
      } else if (e.name === 'page.tsx') out.push({ url: url || '/', file: `app${rel}/page.tsx` });
    }
  })(APP, '', '');
  return out;
}

test('registry: unique paths and titles, descriptions within 155 and free of banned words', () => {
  assert.equal(new Set(PUBLIC_PAGES.map((p) => p.path)).size, PUBLIC_PAGES.length);
  assert.equal(new Set(PUBLIC_PAGES.map((p) => p.title)).size, PUBLIC_PAGES.length);
  for (const p of PUBLIC_PAGES) {
    assert.match(p.path, /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/, p.path);
    assert.ok(p.description.length <= 155, `${p.path}: ${p.description.length} characters`);
    for (const re of BANNED) assert.doesNotMatch(`${p.title} ${p.description}`, re, `${p.path} matches ${re}`);
  }
});

test('registry: every published path has a page (a static page.tsx, or a slug its generateStaticParams returns)', async () => {
  const all = routes();
  for (const p of PUBLIC_PAGES.filter((x) => x.published)) {
    if (all.some((r) => r.url === p.path)) continue;
    const parent = p.path.slice(0, p.path.lastIndexOf('/'));
    const slug = p.path.slice(p.path.lastIndexOf('/') + 1);
    const dyn = all.find((r) => r.url.startsWith(`${parent}/[`) && r.url.split('/').length === p.path.split('/').length);
    assert.ok(dyn, `${p.path}: no page.tsx and no dynamic segment under ${parent}`);
    const [url] = compile([dyn.file.replace(/^app/, 'app')]);
    const mod = await import(url);
    assert.equal(typeof mod.generateStaticParams, 'function', `${dyn.file} has no generateStaticParams`);
    const params = await mod.generateStaticParams();
    assert.ok(params.some((o) => Object.values(o).includes(slug)), `${p.path}: slug not returned by ${dyn.file}`);
  }
});

test('pageMetadata: complete Open Graph and Twitter on every page (Next merges shallowly)', () => {
  for (const p of PUBLIC_PAGES) {
    const m = pageMetadata(p);
    assert.equal(m.openGraph.images.length, 1, p.path);
    assert.equal(m.openGraph.siteName, 'stem-loops', p.path);
    assert.equal(m.twitter.card, 'summary_large_image', p.path);
    assert.equal(m.alternates.canonical, p.path);
    if (!p.published) assert.equal(m.robots.index, false, p.path);
  }
});

test('pages.ts: every minute figure in a description comes from ${MAX_TRACK_MIN}', () => {
  const src = readFileSync(join(APP, '..', 'lib', 'seo', 'pages.ts'), 'utf8').replaceAll('${MAX_TRACK_MIN} minutes', '');
  // The landing test's literal-minute pattern (landing-copy.test.mjs), applied to the registry source.
  const literal = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:&nbsp;|\\u00a0|\s)*minutes?\b/i;
  assert.doesNotMatch(src, literal);
});
