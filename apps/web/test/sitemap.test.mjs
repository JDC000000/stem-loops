// SEO-01: sitemap.xml lists exactly the published registry pages and nothing private.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sitemap from '../src/app/sitemap.ts';
import robots from '../src/app/robots.ts';
import { PUBLIC_PAGES } from '../src/lib/seo/pages.ts';
import { DEMO_SONGS, demoHref } from '../src/lib/demo-catalog.ts';

// /pricing is public and indexable since P6 (2026-11-17); it is asserted IN the sitemap by
// test/pricing-indexable.test.mjs.
const EXCLUDED = ['/login', '/history', '/account', '/trial', '/success', '/jobs/', '/api/'];

test('sitemap: absolute, unique, published only, no app routes', () => {
  const urls = sitemap().map((e) => e.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls.length, PUBLIC_PAGES.filter((p) => p.published).length + DEMO_SONGS.length);
  for (const u of urls) {
    assert.match(u, /^https:\/\/stem-loops\.com\//);
    const path = u.replace('https://stem-loops.com', '');
    for (const x of EXCLUDED) assert.ok(!path.startsWith(x), `${u} is excluded`);
  }
});

// QA-55: the demo songs are public (signed-out playable since #302) and belong in the sitemap.
test('sitemap: lists every demo song route from the catalog, and no other /demo URL', () => {
  const urls = sitemap().map((e) => e.url);
  assert.ok(DEMO_SONGS.length > 0);
  for (const d of DEMO_SONGS) assert.ok(urls.includes(`https://stem-loops.com${demoHref(d.slug)}`), `${d.slug} missing from sitemap`);
  assert.equal(urls.filter((u) => u.startsWith('https://stem-loops.com/demo/')).length, DEMO_SONGS.length);
  for (const e of sitemap()) assert.match(String(e.lastModified), /^\d{4}-\d{2}-\d{2}$/);
});

test('robots.txt does not disallow /demo for any crawler that may index the site', () => {
  for (const r of robots().rules) {
    const dis = [r.disallow ?? []].flat();
    if (dis.includes('/')) continue; // the blocked AI training crawlers: whole site, by design
    for (const d of dis) assert.ok(!'/demo/lucky-ticket'.startsWith(d), `${r.userAgent} disallows ${d}`);
  }
});

test('robots.txt names the sitemap', () => {
  assert.equal(robots().sitemap, 'https://stem-loops.com/sitemap.xml');
});
