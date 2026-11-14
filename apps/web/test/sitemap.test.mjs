// SEO-01: sitemap.xml lists exactly the published registry pages and nothing private.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sitemap from '../src/app/sitemap.ts';
import robots from '../src/app/robots.ts';
import { PUBLIC_PAGES } from '../src/lib/seo/pages.ts';

const EXCLUDED = ['/login', '/history', '/account', '/trial', '/success', '/pricing', '/jobs/', '/api/'];

test('sitemap: absolute, unique, published only, no app routes', () => {
  const urls = sitemap().map((e) => e.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls.length, PUBLIC_PAGES.filter((p) => p.published).length);
  for (const u of urls) {
    assert.match(u, /^https:\/\/stem-loops\.com\//);
    const path = u.replace('https://stem-loops.com', '');
    for (const x of EXCLUDED) assert.ok(!path.startsWith(x), `${u} is excluded`);
  }
});

test('robots.txt names the sitemap', () => {
  assert.equal(robots().sitemap, 'https://stem-loops.com/sitemap.xml');
});
