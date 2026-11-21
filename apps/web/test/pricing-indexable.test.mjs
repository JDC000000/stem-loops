// P6 (Jon, 2026-11-17): /pricing is public and indexable, and "Pricing" is in the top nav,
// signed in and signed out.
//
// Before P6, app/pricing/page.tsx declared `robots: { index: false, follow: false }`, the page
// was missing from the registry, the sitemap and llms.txt, and the nav had no Pricing item.
// Each of those is asserted here on EXECUTED output (the compiled layout's metadata, the
// sitemap and llms.txt as served, the rendered nav), with one source check for the page file,
// which imports the DB and cannot be executed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { compile, navigationStub, toMarkup } from './helpers/render-chrome.mjs';
import sitemap from '../src/app/sitemap.ts';
import robots from '../src/app/robots.ts';
import { GET as llms } from '../src/app/llms.txt/route.ts';
import { pageFor } from '../src/lib/seo/pages.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const STUBS = { '@/components/chrome/SignedInChrome': 'export default function SignedInChrome() { return null; }' };

test('/pricing layout: metadata is the registry entry, and it does not say noindex', async () => {
  const [url] = compile(['app/pricing/layout.tsx'], STUBS);
  const mod = await import(url);
  // A4: generateMetadata (the shared OG image reads the DB-17 runtime switch per request).
  const m = mod.metadata ?? mod.generateMetadata?.();
  assert.ok(m, 'app/pricing/layout.tsx exports metadata');
  assert.notEqual(m.robots?.index, false, 'the layout still declares noindex');
  assert.notEqual(m.robots?.follow, false);
  assert.equal(m.alternates?.canonical, '/pricing');
  assert.equal(m.title, 'Pricing');
  // Still dynamic: the bar and the buy buttons are session-aware.
  assert.equal(mod.dynamic, 'force-dynamic');
});

test('/pricing page: no metadata of its own, and no noindex anywhere in the file', () => {
  const src = readFileSync(join(SRC, 'app/pricing/page.tsx'), 'utf8');
  assert.doesNotMatch(src, /robots:\s*\{/);
  assert.doesNotMatch(src, /index:\s*false/);
  // A page `metadata` export would be merged over the layout's; there must not be one.
  assert.doesNotMatch(src, /export\s+const\s+metadata\b/);
});

test('/pricing is published in the registry, listed in the sitemap and llms.txt, and not blocked by robots', async () => {
  const p = pageFor('/pricing');
  assert.ok(p, '/pricing is not in lib/seo/pages.ts');
  assert.equal(p.published, true);
  assert.ok(sitemap().some((e) => e.url === 'https://stem-loops.com/pricing'), 'sitemap omits /pricing');
  const body = await llms().text();
  assert.ok(body.includes('(https://stem-loops.com/pricing)'), 'llms.txt omits /pricing');
  const all = robots().rules.find((r) => r.userAgent === '*');
  assert.equal(all.allow, '/');
  assert.ok(!all.disallow, 'the * rule disallows something');
  for (const r of robots().rules.filter((x) => x.disallow && x.allow === '/')) {
    assert.ok(![r.disallow].flat().some((d) => '/pricing'.startsWith(d)), `${r.userAgent} is kept off /pricing`);
  }
});

test('the top nav carries "Pricing" → /pricing signed in, signed out, and on the static marketing pages', async () => {
  for (const [path, signedIn] of [['/', null], ['/loops', false], ['/account', true], ['/pricing', false], ['/pricing', true]]) {
    const [url] = compile(['components/chrome/SignedInNav.tsx'], { 'next/navigation': navigationStub(path) });
    const { default: SignedInNav } = await import(`${url}?${Math.random()}`);
    const html = await toMarkup(React.createElement(SignedInNav, { signedIn }));
    const menu = html.match(/<nav\b[^>]*id="sin-menu"[\s\S]*?<\/nav>/)?.[0] ?? '';
    const items = [...menu.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], text: m[2].trim() }));
    const pricing = items.filter((i) => i.text === 'Pricing');
    assert.equal(pricing.length, 1, `at ${path} (signedIn=${signedIn}): ${items.map((i) => i.text).join(' | ')}`);
    assert.match(pricing[0].attrs, /href="\/pricing"/);
    // Current only on /pricing, and it never names a product.
    assert.equal(/aria-current="page"/.test(pricing[0].attrs), path === '/pricing', `aria-current at ${path}`);
    if (path === '/pricing') assert.doesNotMatch(html, /data-testid="sin-product"/);
  }
});
