// THE SIGNED-IN HEADER — GATED ON RENDERED OUTPUT.
//
// The defect this closes: before this change, NOT ONE signed-in route had any
// chrome. SiteHeader (components/landing/SiteChrome.tsx) was imported by
// exactly four files — app/(landing)/page.tsx, (landing)/terms,
// (landing)/privacy and not-found — so /account, /jobs/[id], /history,
// /login, /pricing, /success and /trial each rendered with no way back into
// the tool except the browser's back button. On /account the single
// `<a href="/">Extract some loops</a>` sat INSIDE the `jobs.length === 0`
// branch, so it vanished for exactly the users who had come back.
//
// WHY EVERY ASSERTION HERE READS MARKUP.
// A source-text assertion is satisfied by a comment, a string literal, a
// template or a regex. This repo has already paid for that lesson six times
// over (see the header of test/job-page-render.test.mjs). So the harness
// compiles the REAL modules and renders them, and the gates read what came
// out. The components under test are never stubbed: test/helpers/render-chrome.mjs
// keeps an allowlist of what may be, and it holds only the two things node
// cannot supply — a Supabase session, and the router behind usePathname.
//
// THE DEAD-END GATE is "layout chain" below. For each signed-in route it reads
// app/ FROM DISK, collects the layouts that really wrap that route, renders
// that chain, and requires a link to the tool in the result. It goes red if
// the chrome is removed from a layout, if a layout is deleted, or if a route
// is moved out from under one. "no routable page is left without chrome"
// catches the fourth case, a NEW route added outside the covered subtrees.
//
// CONTROL. "every internal href the bar emits resolves to a page.tsx in app/"
// must stay GREEN. It replaced the old control ("there is no /loops route")
// when /loops landed (Story 6): that statement became false, so the gate moved
// to the general form of what it was guarding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import {
  compile,
  navigationStub,
  authStub,
  authThrowsStub,
  chromePortalStub,
  toMarkup,
} from './helpers/render-chrome.mjs';
import { withDom } from './helpers/dom.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

/** The routes this change is responsible for, and the tool they must reach. */
const SIGNED_IN_ROUTES = [
  '/account',
  '/account/delete',
  '/account/reset-password',
  '/history',
  '/demo/[slug]', // Slice 2a: a demo song in the player, signed out included
  '/jobs/[id]',
  '/login',
  '/loops',
  '/pricing',
  '/sets', // Phase B B2 (#322): set lists, the Demo set signed out included
  '/sets/[id]',
  '/success',
  '/trial',
];
const TOOL = '/';

// ─────────────────────────────────────────────────────────────────────────
// Resolving async server components.
//
// SignedInChrome is an async function component: react-dom/server in React 18
// cannot render one inside a tree (it reaches the element and finds a
// Promise). Rather than STUB it — which would mean the dead-end gate never
// touched the real thing — the tree is walked and every async component is
// replaced by what it actually returned. The markup below is therefore
// produced by the real SignedInChrome and the real SignedInNav.
// ─────────────────────────────────────────────────────────────────────────
const isAsyncComponent = (t) =>
  typeof t === 'function' && t.constructor && t.constructor.name === 'AsyncFunction';

async function resolveAsync(node) {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!React.isValidElement(node)) return node;
  if (isAsyncComponent(node.type)) return resolveAsync(await node.type(node.props));
  const kids = node.props?.children;
  if (kids === undefined) return node;
  return React.cloneElement(node, undefined, await resolveAsync(kids));
}

const renderTree = async (el) => toMarkup(await resolveAsync(el));

const JOB_A = '477fb242-695a-4b29-9373-a26b9067a8fa';

/** Render the real SignedInChrome for a given session and path. */
async function chrome({ user = null, path = '/account' } = {}) {
  const [url] = compile(['components/chrome/SignedInChrome.tsx'], {
    'next/navigation': navigationStub(path),
    '@/lib/auth/supabase': user === 'throws' ? authThrowsStub() : authStub(user),
  });
  const mod = await import(`${url}?${Math.random()}`);
  return renderTree(React.createElement(mod.default));
}

/** Every `href="…"` in a blob of markup, in document order. */
const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
/** An item's phone label (A4): `<span class="sin-l-phone">Songs</span>` beside the wide one. */
const PHONE_LABEL = /<span class="sin-l-phone">[\s\S]*?<\/span>/g;
/** Link text keyed by href — enough to say "this label goes there". The WIDE label, as before;
 *  the phone label of the same link is `phone`. */
const links = (html) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: m[1],
    text: m[2].replace(PHONE_LABEL, '').replace(/<[^>]*>/g, '').trim(),
    phone: (m[2].match(/<span class="sin-l-phone">([\s\S]*?)<\/span>/)?.[1] ?? m[2].replace(PHONE_LABEL, '').replace(/<[^>]*>/g, '')).trim(),
    wideOnly: /class="[^"]*\bsin-wide-only\b/.test(m[0]),
  }));

// ═════════════════════════════════════════════════════════════════════════
// 1. The bar renders, in both session states.
// ═════════════════════════════════════════════════════════════════════════

test('signed OUT: the bar offers Sign in and no Account link', async () => {
  const html = await chrome({ user: null, path: '/pricing' });
  const l = links(html);
  assert.ok(l.some((x) => x.text === 'Sign in' && x.href === '/login'), html);
  assert.equal(l.filter((x) => x.text === 'Account').length, 0);
  assert.equal(l.filter((x) => x.href === '/account').length, 0);
});

test('signed IN: the bar offers Account and no Sign in link', async () => {
  const html = await chrome({ user: { user_id: 'u1', email: 'a@b.c' }, path: '/pricing' });
  const l = links(html);
  assert.ok(l.some((x) => x.text === 'Account' && x.href === '/account'), html);
  assert.equal(l.filter((x) => x.text === 'Sign in').length, 0);
});

test('the bar carries every item it claims to', async () => {
  const html = await chrome({ user: { user_id: 'u1', email: 'a@b.c' } });
  const l = links(html);
  const by = (t) => l.find((x) => x.text === t);
  assert.ok(l.some((x) => x.href === TOOL), 'wordmark must link to the tool');
  assert.equal(by('Play along')?.href, TOOL);
  assert.equal(by('Download loops')?.href, '/loops');
  assert.equal(by('Song library')?.href, '/history');
  assert.equal(by('Account')?.href, '/account');
  assert.equal(by('Pricing')?.href, '/pricing');
  // Exactly these, in this order (Story 7.2; the design canvas order). An item
  // added without a gate turns this red rather than sliding in.
  // Link TEXT, in document order — the wordmark reads "stem-loops"; its
  // accessible name ("stem-loops, home") is asserted separately above.
  assert.deepEqual(l.map((x) => x.text).filter(Boolean), [
    'stem-loops',
    'Play along',
    'Download loops',
    'Song library',
    // P6 (Jon, 2026-11-17): Pricing in the top nav, signed in and out.
    'Pricing',
    'Account',
  ]);
});

test('"Download loops" (Jon\'s label) goes to /loops in every session state, never a fragment or a job', async () => {
  // The item was withheld while the loops lived inside the job page, where the
  // only target was a fragment on a URL this bar has no id for. /loops takes no
  // id. What stays forbidden is the old defect: a `#loops` fragment, or an href
  // tied to one job.
  for (const user of [null, { user_id: 'u1', email: 'a@b.c' }, 'throws']) {
    const html = await chrome({ user });
    const l = links(html);
    assert.equal(l.filter((x) => x.text === 'Download loops').length, 1, l.map((x) => x.text).join(' | '));
    assert.equal(l.find((x) => x.text === 'Download loops').href, '/loops');
    assert.ok(!l.some((x) => x.text === 'Song loops'), 'the unsettled alternative label shipped');
    assert.ok(!hrefs(html).some((h) => h.includes('#')), hrefs(html).join(' | '));
    assert.ok(!hrefs(html).some((h) => h.includes('?')), hrefs(html).join(' | '));
  }
});

test('getUser throwing degrades to the signed-out bar, not to a dead end', async () => {
  const html = await chrome({ user: 'throws', path: '/account' });
  assert.ok(links(html).some((x) => x.text === 'Sign in'));
  assert.ok(hrefs(html).includes(TOOL), 'a route to the tool must survive a Supabase outage');
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Accessibility affordances, read off the markup.
// ═════════════════════════════════════════════════════════════════════════

test('A4: on a phone the bar is three items, Play · Songs · Account, with no menu toggle', async () => {
  // Jon's J1/J8 story (2026-11-21): five items behind a menu became three inline items, so the
  // Song library is one tap from any page. Download loops and Pricing are desktop-only in the bar
  // (signed-in-nav.css hides .sin-wide-only below 760px); on a phone they are on /account and in
  // the footer.
  for (const [user, last] of [[{ user_id: 'u', email: 'a@b.c' }, 'Account'], [null, 'Sign in']]) {
    const html = await chrome({ user, path: '/history' });
    assert.doesNotMatch(html, /sin-toggle|sin-bars|aria-expanded/, 'the phone menu toggle is back');
    const items = links(html).filter((x) => x.text !== 'stem-loops');
    assert.deepEqual(items.filter((x) => !x.wideOnly).map((x) => x.phone), ['Play', 'Songs', last]);
    assert.deepEqual(items.filter((x) => x.wideOnly).map((x) => x.text), ['Download loops', 'Pricing']);
  }
  const css = readFileSync(join(APP, '..', 'styles', 'signed-in-nav.css'), 'utf8');
  const phone = css.match(/@media \(max-width: 759px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(phone, /\.sin-wide-only \{ display: none; \}/);
  assert.match(phone, /\.sin-l-wide \{ display: none; \}/);
  assert.match(phone, /\.sin-l-phone \{ display: inline; \}/);
  assert.match(css, /^\.sin-l-phone \{ display: none; \}/m, 'the phone label is hidden on wide screens');
  // The account page carries the two items that left the phone bar.
  const account = readFileSync(join(APP, 'account', 'page.tsx'), 'utf8');
  assert.match(account, /<a href="\/pricing">/);
  assert.match(account, /<a href="\/loops">/);
});

test('exactly one item is aria-current="page", and it is the right one', async () => {
  for (const [path, label] of [
    ['/', 'Play along'],
    ['/account', 'Account'],
    ['/account/delete', 'Account'],
    ['/history', 'Song library'],
    [`/jobs/${JOB_A}`, 'Play along'],
    ['/loops', 'Download loops'],
    ['/pricing', 'Pricing'],
  ]) {
    const html = await chrome({ user: { user_id: 'u', email: 'a@b.c' }, path });
    const marked = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map(
      (m) => m[1].replace(PHONE_LABEL, '').replace(/<[^>]*>/g, '').trim(),
    );
    assert.deepEqual(marked, [label], `at ${path}`);
  }
});

test('signed out on /login, the Sign in item is the current page', async () => {
  const html = await chrome({ user: null, path: '/login' });
  const marked = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map(
    (m) => m[1].replace(/<[^>]*>/g, '').trim(),
  );
  assert.deepEqual(marked, ['Sign in']);
});

test('a page with no match marks nothing current', async () => {
  const html = await chrome({ user: { user_id: 'u', email: 'a@b.c' }, path: '/success' });
  assert.equal([...html.matchAll(/aria-current="page"/g)].length, 0);
});

// ═════════════════════════════════════════════════════════════════════════
// 3. The product item points at the tool — and at nothing session-specific.
// ═════════════════════════════════════════════════════════════════════════

test('"Play along" goes to the tool, for every session state', async () => {
  for (const user of [null, { user_id: 'u1', email: 'a@b.c' }, 'throws']) {
    const l = links(await chrome({ user }));
    assert.equal(l.find((x) => x.text === 'Play along')?.href, TOOL);
  }
});

test('the bar never reads the sl-history cookie', async () => {
  // It used to, to deep-link "Play along" at the viewer's newest job. That
  // cookie is the ANONYMOUS, per-BROWSER history mirror and is never scoped to
  // the signed-in user, so on a shared machine it pointed one account's nav at
  // another account's job — and app/jobs/[id]/page.tsx has no ownership check.
  // This gate is structural: the chrome's compiled module graph must not
  // mention next/headers or that cookie at all, so the deep link cannot come
  // back without someone reading this comment.
  const src = readFileSync(join(APP, '..', 'components/chrome/SignedInChrome.tsx'), 'utf8');
  const nav = readFileSync(join(APP, '..', 'components/chrome/SignedInNav.tsx'), 'utf8');
  for (const [name, text] of [['SignedInChrome', src], ['SignedInNav', nav]]) {
    assert.ok(!text.includes("from 'next/headers'"), `${name} imports next/headers`);
    assert.ok(!text.includes('history-cookie'), `${name} imports the history cookie reader`);
  }
  // And the rendered proof: no job-specific href is produced for any session.
  for (const user of [null, { user_id: 'u1', email: 'a@b.c' }]) {
    const html = await chrome({ user });
    assert.ok(!hrefs(html).some((h) => h.startsWith('/jobs/')), hrefs(html).join(' | '));
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 4. THE DEAD-END GATE — every signed-in route, through its real layouts.
// ═════════════════════════════════════════════════════════════════════════

/** The layouts that really wrap `route`, outermost first, root layout excluded. */
function layoutChain(route) {
  const parts = route.split('/').filter(Boolean);
  const chain = [];
  let dir = APP;
  // `entries()`, not `indexOf(p)`: indexOf returns the segment's FIRST index,
  // so a route that repeats a segment (/jobs/jobs) would rebuild the wrong
  // prefix while `dir` walked the right one. Harmless on today's routes and
  // wrong the moment one repeats.
  for (const [i, p] of parts.entries()) {
    dir = join(dir, p);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) break;
    if (existsSync(join(dir, 'layout.tsx'))) {
      chain.push(`app/${parts.slice(0, i + 1).join('/')}/layout.tsx`);
    }
  }
  return chain;
}

test('layout chain: every signed-in route renders a link to the tool', async () => {
  const marker = React.createElement('main', { id: 'page-body' }, 'page');
  const KEY = '__signed_in_nav_test_chrome__';

  for (const route of SIGNED_IN_ROUTES) {
    const chain = layoutChain(route);
    assert.ok(chain.length > 0, `${route} is wrapped by no layout — it is a dead end`);

    const stubs = {
      'next/navigation': navigationStub(route),
      '@/lib/auth/supabase': authStub({ user_id: 'u', email: 'a@b.c' }),
    };

    // Run the REAL chrome for this route and park its element where the
    // portal stub will find it. If SignedInChrome stops producing a bar, this
    // is null and every assertion below fails — the stub adds no markup of
    // its own.
    const [chromeUrl] = compile(['components/chrome/SignedInChrome.tsx'], stubs);
    const chromeMod = await import(`${chromeUrl}?${Math.random()}`);
    globalThis[KEY] = await chromeMod.default();

    const urls = compile(chain, { ...stubs, '@/components/chrome/SignedInChrome': chromePortalStub(KEY) });
    const mods = await Promise.all(urls.map((u) => import(`${u}?${Math.random()}`)));

    const tree = mods.reduceRight(
      (child, m) => React.createElement(m.default, null, child),
      marker,
    );
    const html = await renderTree(tree);
    delete globalThis[KEY];

    assert.ok(html.includes('id="page-body"'), `${route}: the page body did not render`);
    assert.ok(
      hrefs(html).includes(TOOL),
      `${route} HAS NO LINK TO THE TOOL — this is the dead end the change exists to remove.\n${html}`,
    );
    assert.ok(
      links(html).some((x) => x.text === 'Play along'),
      `${route}: no "Play along" item in the rendered chrome`,
    );
  }
});

test('no routable page is left without chrome', async () => {
  // Walk app/ for page.tsx files and insist each is either in the marketing
  // group (which keeps SiteHeader) or under a subtree whose layout mounts the
  // signed-in bar. A route added tomorrow outside both turns this red.
  const pages = [];
  (function walk(dir, rel) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}/${e.name}`);
      else if (e.name === 'page.tsx') pages.push(rel || '/');
    }
  })(APP, '');

  const covered = [];
  const marketing = [];
  const naked = [];
  for (const p of pages) {
    if (p.startsWith('/(landing)')) marketing.push(p);
    else if (layoutChain(p).length > 0) covered.push(p);
    else naked.push(p);
  }
  assert.deepEqual(naked, [], `these routes render with no chrome at all: ${naked.join(', ')}`);
  // landing, /help (Slice 1b, P7), /privacy, /terms — each renders SiteHeader itself.
  assert.equal(marketing.length, 4, `marketing pages: ${marketing.join(', ')}`);
  assert.equal(covered.length, SIGNED_IN_ROUTES.length, `covered: ${covered.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════════════════
// 5. CONTROL — a true statement, plainly made, that must stay green.
// ═════════════════════════════════════════════════════════════════════════

test('CONTROL: every internal href the bar emits resolves to a real page in app/', async () => {
  // The old control asserted "there is no /loops route". That became false the
  // day /loops landed, so it moved to the general form of what it guarded:
  // the bar cannot tell a live href from a dead one (which is how a `#loops`
  // fragment once shipped), so the filesystem is asked instead.
  assert.ok(existsSync(join(APP, 'loops', 'page.tsx')), 'Download loops points at a page that does not exist');
  const pageFor = (href) =>
    href === '/'
      ? join(APP, '(landing)', 'page.tsx')
      : join(APP, ...href.split('/').filter(Boolean), 'page.tsx');
  for (const user of [null, { user_id: 'u', email: 'a@b.c' }]) {
    for (const path of ['/account', '/loops', `/jobs/${JOB_A}`]) {
      const html = await chrome({ user, path });
      // A query (Sign in on /loops carries ?return_to) does not change which page it is.
      for (const h of hrefs(html).map((x) => x.split('?')[0])) {
        assert.ok(existsSync(pageFor(h)), `the bar links to ${h}, which has no page.tsx`);
      }
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 5b. STORY 7 — which product you are in, and the way back from Account.
// ═════════════════════════════════════════════════════════════════════════

/** The product tag beside the wordmark, or null. */
const productTag = (html) =>
  html.match(/data-testid="sin-product"[^>]*>([\s\S]*?)<\/span>/)?.[1].trim() ?? null;

test('Story 7.4: the bar names the product you are in, at every width (not only via the folded menu)', async () => {
  for (const [path, tag] of [
    ['/', 'Play along'],
    [`/jobs/${JOB_A}`, 'Play along'],
    // The tag carries the nav's own label (2026-11-15), not a shorter alias.
    ['/loops', 'Download loops'],
    ['/account', null],
    ['/history', null],
    ['/pricing', null],
  ]) {
    for (const user of [null, { user_id: 'u', email: 'a@b.c' }]) {
      const html = await chrome({ user, path });
      assert.equal(productTag(html), tag, `at ${path}`);
    }
  }
  // The tag lives OUTSIDE the nav. A4: below 760px it gives way to the three inline items (a
  // 360px bar has no room for both); the current item says where you are.
  const html = await chrome({ user: null, path: '/loops' });
  const menu = html.match(/<nav\b[^>]*id="sin-menu"[\s\S]*?<\/nav>/)[0];
  assert.ok(!menu.includes('sin-product'), 'the product tag is inside the nav');
  assert.ok(html.indexOf('sin-product') < html.indexOf('id="sin-menu"'));
});

test('Story 7.3: from Account, both products are one visible click away', async () => {
  const html = await chrome({ user: { user_id: 'u', email: 'a@b.c' }, path: '/account' });
  const l = links(html);
  assert.equal(l.find((x) => x.text === 'Play along')?.href, TOOL);
  assert.equal(l.find((x) => x.text === 'Download loops')?.href, '/loops');
});

// ═════════════════════════════════════════════════════════════════════════
// 6. THE PHONE BAR, MOUNTED. A4 (2026-11-21) removed the menu toggle that this section used to
// click: on a phone the three items are inline, with nothing to open. What is gated now, on a
// real mounted DOM (happy-dom, React effects), is that the session hint still swaps the last item
// and that every item is a plain link in the nav from the first paint. Layout is unreachable
// here; the 360/390 pixels were measured in Chromium and are in the PR.
// ═════════════════════════════════════════════════════════════════════════

test('mounted: every item is in the nav from the first paint, and the phone set is Play · Songs · Sign in', async () => {
  const [url] = compile(['components/chrome/SignedInNav.tsx'], {
    'next/navigation': navigationStub('/account'),
  });
  const { default: SignedInNav } = await import(`${url}?${Math.random()}`);

  await withDom(async (dom) => {
    await dom.mount(React.createElement(SignedInNav, { signedIn: false }));
    assert.equal(dom.find('.sin-toggle'), null, 'a menu toggle is back');
    const all = dom.findAll('#sin-menu a.sin-item');
    const wide = all.map((a) => (a.querySelector('.sin-l-wide')?.textContent ?? a.textContent).trim());
    assert.deepEqual(wide, ['Play along', 'Download loops', 'Song library', 'Pricing', 'Sign in']);
    const phone = all
      .filter((a) => !a.className.split(/\s+/).includes('sin-wide-only'))
      .map((a) => (a.querySelector('.sin-l-phone')?.textContent ?? a.textContent).trim());
    assert.deepEqual(phone, ['Play', 'Songs', 'Sign in']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 7. THE BAR MUST NEVER BE PRERENDERED.
//
// Found by reading the build's route table, not by a test — which is why
// there is now a test. `SignedInChrome` awaits getUser(), and a session-aware
// bar in a STATIC segment bakes `signedIn: false` into the HTML: a signed-in
// visitor is served a cached "Sign in". Next does not infer the dynamic
// requirement here — @supabase/ssr reads the cookie jar behind its own error
// handling, so no DynamicServerError escapes — and `/history` duly built as
// `○ /history` until every one of these layouts declared it. With the
// declaration it builds as `ƒ /history`.
//
// Asserted by EVALUATING each layout module and reading its exported route
// segment config, not by grepping for the string.
// ═════════════════════════════════════════════════════════════════════════

test('every signed-in layout opts its segment out of static rendering', async () => {
  const layouts = SIGNED_IN_ROUTES.flatMap(layoutChain);
  const unique = [...new Set(layouts)];
  assert.equal(unique.length, 10, `expected 10 signed-in layouts (Slice 2a added app/demo, Phase B B2 app/sets), got: ${unique.join(', ')}`);

  const urls = compile(unique, {
    'next/navigation': navigationStub('/account'),
    '@/lib/auth/supabase': authStub(null),
  });
  for (const [i, url] of urls.entries()) {
    const mod = await import(`${url}?${Math.random()}`);
    assert.equal(
      mod.dynamic,
      'force-dynamic',
      `${unique[i]} does not export dynamic='force-dynamic', so its segment can be ` +
        'prerendered with a signed-out bar baked in',
    );
  }
});

// PR #332 round 2: on a phone the current item is marked (aria-current + the brand selected state,
// #222 with a 2px #fff edge, never lime or amber), and /loops, which has no phone item, keeps its
// product tag under the wordmark (Story 8.4 at every width).
test('phone: the current item is marked, and /loops keeps its product tag under the wordmark', async () => {
  const css = readFileSync(join(APP, '..', 'styles', 'signed-in-nav.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const cur = [...css.matchAll(/\.sin-item\.sin-current\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.match(cur, /background:\s*var\(--bg-selected\)/);
  assert.match(cur, /border-width:\s*2px/);
  assert.match(cur, /border-color:\s*var\(--text-primary\)/);
  assert.doesNotMatch(cur, /accent|chord-now|#a3e635|#f59e0b/);
  const phone = css.match(/@media \(max-width: 759px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(phone, /\.sin-product\[data-product="Download loops"\] \{ display: inline-flex;/);
  assert.match(phone, /\.sin-brand:has\(\.sin-product\[data-product="Download loops"\]\) \{ flex-direction: column;/);
  for (const [path, current, tag] of [['/history', 'Song library', null], ['/', 'Play along', 'Play along'], ['/loops', 'Download loops', 'Download loops']]) {
    const html = await chrome({ user: { user_id: 'u', email: 'a@b.c' }, path });
    const marked = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(PHONE_LABEL, '').replace(/<[^>]*>/g, '').trim());
    assert.deepEqual(marked, [current], path);
    const t = html.match(/<span class="sin-product" data-testid="sin-product" data-product="([^"]+)">/)?.[1] ?? null;
    assert.equal(t, tag, path);
  }
});
