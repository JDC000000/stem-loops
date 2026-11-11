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
// CONTROL. A gate that forbids a true statement is its own defect, so one gate
// here asserts a true thing plainly and is expected to survive every mutant.
// It used to be "there is no /loops route"; /loops now exists, so the control
// has moved to a statement that is still plain and still true: every href this
// bar emits resolves to a page that is actually in app/.

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
  '/jobs/[id]',
  '/login',
  '/loops',
  '/pricing',
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
/** Link text keyed by href — enough to say "this label goes there". */
const links = (html) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: m[1],
    text: m[2].replace(/<[^>]*>/g, '').trim(),
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
  assert.equal(by('Job history')?.href, '/history');
  assert.equal(by('Account')?.href, '/account');
  // Exactly these five, in this order. A sixth item added without a gate turns
  // this red rather than sliding in.
  // Link TEXT, in document order — the wordmark reads "stem-loops"; its
  // accessible name ("stem-loops, home") is asserted separately above.
  assert.deepEqual(l.map((x) => x.text).filter(Boolean), [
    'stem-loops',
    'Play along',
    'Download loops',
    'Job history',
    'Account',
  ]);
});

test('the loops item goes to the page, in BOTH session states, and never to a fragment', async () => {
  // THE HALF THAT CHANGED. The item was withheld until /loops existed; it now
  // does (app/loops/page.tsx), so the item ships and this gate turns positive.
  //
  // THE HALF THAT DID NOT. The defect that kept it out was never the label —
  // it was the TARGET. `/jobs/<id>#loops` needed an id the bar cannot honestly
  // get, and the `#loops` anchor lives inside the `job.status === 'done'`
  // branch of JobView, so it does not exist for a processing, failed or
  // expired job. A fragment is therefore still banned here, and so is any
  // job-specific href, which the sl-history gate below also pins.
  for (const user of [null, { user_id: 'u1', email: 'a@b.c' }]) {
    const html = await chrome({ user });
    const l = links(html);
    const item = l.find((x) => x.text === 'Download loops');
    assert.ok(item, `no loops item for ${user ? 'a signed-in' : 'a signed-out'} viewer`);
    assert.equal(item.href, '/loops');
    assert.ok(!hrefs(html).some((h) => h.includes('#loops')), hrefs(html).join(' | '));
    assert.ok(!hrefs(html).some((h) => h.startsWith('/jobs/')), hrefs(html).join(' | '));
  }
});

test('/loops is a real route, so the item is not a link to a 404', async () => {
  // The item's whole premise. Asserted against the filesystem rather than
  // against the bar, because the bar cannot tell a live href from a dead one —
  // which is exactly how the `#loops` fragment shipped in the first place.
  assert.ok(existsSync(join(APP, 'loops', 'page.tsx')), 'app/loops/page.tsx is gone');
  assert.ok(existsSync(join(APP, 'loops', 'layout.tsx')), 'app/loops/layout.tsx is gone');
});

test('getUser throwing degrades to the signed-out bar, not to a dead end', async () => {
  const html = await chrome({ user: 'throws', path: '/account' });
  assert.ok(links(html).some((x) => x.text === 'Sign in'));
  assert.ok(hrefs(html).includes(TOOL), 'a route to the tool must survive a Supabase outage');
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Accessibility affordances, read off the markup.
// ═════════════════════════════════════════════════════════════════════════

test('the icon-only menu toggle carries aria-label and aria-expanded', async () => {
  const html = await chrome({ user: null });
  const btn = html.match(/<button\b[^>]*class="[^"]*sin-toggle[^"]*"[^>]*>/);
  assert.ok(btn, 'no toggle rendered');
  assert.match(btn[0], /aria-label="[^"]+"/);
  assert.match(btn[0], /aria-expanded="(true|false)"/);
  assert.match(btn[0], /aria-controls="sin-menu"/);
  // It is icon-only on purpose: no text node inside, so aria-label is the name.
  assert.match(html, /<button\b[^>]*sin-toggle[\s\S]*?<span class="sin-bars"[^>]*><\/span><\/button>/);
});

test('exactly one item is aria-current="page", and it is the right one', async () => {
  for (const [path, label] of [
    ['/account', 'Account'],
    ['/account/delete', 'Account'],
    ['/history', 'Job history'],
    ['/loops', 'Download loops'],
    [`/jobs/${JOB_A}`, 'Play along'],
  ]) {
    const html = await chrome({ user: { user_id: 'u', email: 'a@b.c' }, path });
    const marked = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map(
      (m) => m[1].replace(/<[^>]*>/g, '').trim(),
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
  assert.equal(marketing.length, 3, `marketing pages: ${marketing.join(', ')}`);
  assert.equal(covered.length, SIGNED_IN_ROUTES.length, `covered: ${covered.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════════════════
// 5. CONTROL — a true statement, plainly made, that must stay green.
// ═════════════════════════════════════════════════════════════════════════

test('CONTROL: every item in the bar points at a page that exists', async () => {
  // This is the control mutant's home. It states something TRUE and plain:
  // every internal href this bar emits resolves to a page.tsx in app/. Every
  // mutant in the table must leave it GREEN. A suite that cannot tolerate a
  // true statement is testing its own phrasing, not the product.
  //
  // It replaces "there is no /loops route", which was true until this change
  // and is now false. The replacement is the GENERAL form of what that one
  // was guarding — a nav item must not be a link to a 404 — so it keeps
  // working whatever the bar carries next.
  const pageFor = (href) => {
    if (href === '/') return join(APP, '(landing)', 'page.tsx');
    return join(APP, ...href.replace(/^\//, '').split('/'), 'page.tsx');
  };
  for (const user of [null, { user_id: 'u', email: 'a@b.c' }]) {
    const html = await chrome({ user });
    const internal = hrefs(html).filter((h) => h.startsWith('/'));
    assert.ok(internal.length > 0, 'the bar emitted no links at all');
    for (const href of internal) {
      assert.ok(existsSync(pageFor(href)), `the bar links to ${href}, which has no page.tsx`);
    }
    // And it still gets the viewer back to the tool.
    assert.ok(hrefs(html).includes(TOOL));
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 6. THE TOGGLE ACTUALLY TOGGLES — a real DOM, a real click, real state.
//
// WHY THIS SECTION EXISTS. Every gate above goes through
// renderToStaticMarkup, which renders the INITIAL state and never runs an
// event handler. That left a hole a reviewer walked straight through:
// changing `setOpen((v) => !v)` to `setOpen(false)` kept the whole suite at
// 1210/1190/0/20 and `tsc` clean, while in Chromium at 390px the click did
// nothing — aria-expanded stayed "false", `.sin-nav` stayed `display: none`,
// and the number of visible nav items was ZERO.
//
// That is not a cosmetic miss. Below 760px `.sin-nav` is hidden unless
// `.sin-open`, so a dead toggle means a signed-in user ON A PHONE has no
// navigation at all — precisely the dead end this change exists to remove,
// reintroduced for the half of the audience that matters most. The old
// toggle test matched /aria-expanded="(true|false)"/ against initial markup,
// which "false" satisfies forever.
//
// So: mount the real component in happy-dom (test/helpers/dom.mjs — React
// effects, real events), click the real button, and assert the state MOVED.
// Layout is still unreachable here (that helper's own header says so), so
// this gates the STATE MACHINE; the pixels were measured in Chromium and are
// reported in the PR, gated by nothing.
// ═════════════════════════════════════════════════════════════════════════

test('clicking the toggle opens the menu, and clicking again closes it', async () => {
  const [url] = compile(['components/chrome/SignedInNav.tsx'], {
    'next/navigation': navigationStub('/account'),
  });
  const { default: SignedInNav } = await import(`${url}?${Math.random()}`);

  await withDom(async (dom) => {
    await dom.mount(React.createElement(SignedInNav, { signedIn: true }));

    const toggle = dom.find('.sin-toggle');
    const menu = dom.find('#sin-menu');
    assert.ok(toggle && menu, 'the bar did not mount');

    // CLOSED — and the gate would be vacuous if this were already open.
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(!menu.className.split(/\s+/).includes('sin-open'), menu.className);
    const closedLabel = toggle.getAttribute('aria-label');

    // OPEN
    await dom.act(() => toggle.click());
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the click did not open the menu');
    assert.ok(
      menu.className.split(/\s+/).includes('sin-open'),
      `#sin-menu never gained sin-open, so below 760px it stays display:none: ${menu.className}`,
    );
    // The accessible name has to move too, or a screen-reader user is told
    // "Open menu" on an open menu.
    assert.notEqual(toggle.getAttribute('aria-label'), closedLabel);

    // CLOSE AGAIN — kills a `setOpen(true)` mutant, which the open half alone
    // would pass.
    await dom.act(() => toggle.click());
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the menu never closes again');
    assert.ok(!menu.className.split(/\s+/).includes('sin-open'), menu.className);
    assert.equal(toggle.getAttribute('aria-label'), closedLabel);
  });
});

test('every nav item is reachable once the menu is open', async () => {
  // The companion to the above: opening must reveal the WHOLE menu, not just
  // flip an attribute. Asserted on the live DOM inside the opened <nav>.
  const [url] = compile(['components/chrome/SignedInNav.tsx'], {
    'next/navigation': navigationStub('/account'),
  });
  const { default: SignedInNav } = await import(`${url}?${Math.random()}`);

  await withDom(async (dom) => {
    await dom.mount(React.createElement(SignedInNav, { signedIn: false }));
    const toggle = dom.find('.sin-toggle');
    await dom.act(() => toggle.click());

    const items = dom.findAll('#sin-menu.sin-open a.sin-item').map((a) => a.textContent.trim());
    assert.deepEqual(items, ['Play along', 'Download loops', 'Job history', 'Sign in']);
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
  assert.equal(unique.length, 8, `expected 8 signed-in layouts, got: ${unique.join(', ')}`);

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
