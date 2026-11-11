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
// cannot supply — a Supabase session and a request cookie jar.
//
// THE DEAD-END GATE is "layout chain" below. For each signed-in route it reads
// app/ FROM DISK, collects the layouts that really wrap that route, renders
// that chain, and requires a link to the tool in the result. It goes red if
// the chrome is removed from a layout, if a layout is deleted, or if a route
// is moved out from under one. "no routable page is left without chrome"
// catches the fourth case, a NEW route added outside the covered subtrees.
//
// CONTROL. "the bar states plainly that there is no /loops route" must stay
// GREEN. A gate that forbids a true statement is its own defect, so one gate
// here asserts a true thing plainly and is expected to survive every mutant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import {
  compile,
  navigationStub,
  headersStub,
  authStub,
  authThrowsStub,
  chromePortalStub,
  toMarkup,
} from './helpers/render-chrome.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

/** The routes this change is responsible for, and the tool they must reach. */
const SIGNED_IN_ROUTES = [
  '/account',
  '/account/delete',
  '/account/reset-password',
  '/history',
  '/jobs/[id]',
  '/login',
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

/** A correctly signed `sl-history` cookie over `ids` — what the app writes. */
function signHistory(ids) {
  const payload = JSON.stringify(ids);
  const sig = createHmac('sha256', process.env.HISTORY_COOKIE_KEY ?? 'dev')
    .update(payload)
    .digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${sig}`;
}

const JOB_A = '477fb242-695a-4b29-9373-a26b9067a8fa';

/** Render the real SignedInChrome for a given session, cookie jar and path. */
async function chrome({ user = null, cookie = null, path = '/account' } = {}) {
  const [url] = compile(['components/chrome/SignedInChrome.tsx'], {
    'next/navigation': navigationStub(path),
    'next/headers': headersStub(cookie ? { 'sl-history': cookie } : {}),
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

test('the bar carries every item the audit asked for', async () => {
  const html = await chrome({ user: { user_id: 'u1', email: 'a@b.c' } });
  const l = links(html);
  const by = (t) => l.find((x) => x.text === t);
  assert.ok(l.some((x) => x.href === TOOL), 'wordmark must link to the tool');
  assert.ok(by('Play along'), 'Play along missing');
  assert.ok(by('Download loops'), 'Download loops missing');
  assert.equal(by('Job history')?.href, '/history');
  assert.equal(by('Account')?.href, '/account');
});

test('the loops item is labelled exactly "Download loops"', async () => {
  // Jon approved this wording over "Song loops"; the gate is on the RENDERED
  // label, so a renamed constant or a commented-out alternative cannot satisfy it.
  const html = await chrome({ user: { user_id: 'u1', email: 'a@b.c' } });
  const texts = links(html).map((x) => x.text);
  assert.ok(texts.includes('Download loops'), texts.join(' | '));
  assert.ok(!texts.includes('Song loops'), texts.join(' | '));
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
// 3. The two product items point somewhere real — and only somewhere real.
// ═════════════════════════════════════════════════════════════════════════

test('with a signed history cookie, both product items reach that job', async () => {
  const html = await chrome({
    user: { user_id: 'u', email: 'a@b.c' },
    cookie: signHistory([JOB_A, '00000000-0000-4000-8000-000000000001']),
  });
  const l = links(html);
  assert.equal(l.find((x) => x.text === 'Play along')?.href, `/jobs/${JOB_A}`);
  assert.equal(l.find((x) => x.text === 'Download loops')?.href, `/jobs/${JOB_A}#loops`);
});

test('with no cookie, both product items fall back to the tool', async () => {
  const l = links(await chrome({ user: { user_id: 'u', email: 'a@b.c' }, cookie: null }));
  assert.equal(l.find((x) => x.text === 'Play along')?.href, TOOL);
  assert.equal(l.find((x) => x.text === 'Download loops')?.href, TOOL);
});

test('a TAMPERED cookie cannot put its job id into a nav href', async () => {
  const evil = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const forged = `${Buffer.from(JSON.stringify([evil])).toString('base64')}.${'0'.repeat(64)}`;
  const html = await chrome({ user: { user_id: 'u', email: 'a@b.c' }, cookie: forged });
  assert.ok(!html.includes(evil), 'unsigned cookie payload reached the markup');
  assert.equal(links(html).find((x) => x.text === 'Play along')?.href, TOOL);
});

test('a validly signed cookie holding a non-UUID is still not interpolated', async () => {
  const nasty = '../../etc/passwd';
  const html = await chrome({
    user: { user_id: 'u', email: 'a@b.c' },
    cookie: signHistory([nasty, JOB_A]),
  });
  // The first entry is skipped on shape, so the nav lands on the next real id.
  assert.ok(!html.includes('etc/passwd'), html);
  assert.equal(links(html).find((x) => x.text === 'Play along')?.href, `/jobs/${JOB_A}`);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. THE DEAD-END GATE — every signed-in route, through its real layouts.
// ═════════════════════════════════════════════════════════════════════════

/** The layouts that really wrap `route`, outermost first, root layout excluded. */
function layoutChain(route) {
  const parts = route.split('/').filter(Boolean);
  const chain = [];
  let dir = APP;
  for (const p of parts) {
    dir = join(dir, p);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) break;
    const l = join(dir, 'layout.tsx');
    if (existsSync(l)) chain.push(`app/${parts.slice(0, parts.indexOf(p) + 1).join('/')}/layout.tsx`);
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
      'next/headers': headersStub({}),
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

test('CONTROL: there is no /loops route, and the bar does not pretend there is', async () => {
  // This is the control mutant's home. It states something TRUE and plain:
  // the repo has no app/loops directory, so "Download loops" resolves to the
  // loops section of a job page (or to the tool), never to a /loops URL.
  // Every mutant in the table must leave this GREEN. A suite that cannot
  // tolerate a true statement is testing its own phrasing, not the product.
  assert.equal(existsSync(join(APP, 'loops')), false, 'a /loops route now exists — update the nav');

  const withJob = await chrome({
    user: { user_id: 'u', email: 'a@b.c' },
    cookie: signHistory([JOB_A]),
  });
  const withoutJob = await chrome({ user: { user_id: 'u', email: 'a@b.c' } });
  for (const html of [withJob, withoutJob]) {
    assert.ok(!hrefs(html).some((h) => h === '/loops' || h.startsWith('/loops/')), html);
    assert.ok(links(html).some((x) => x.text === 'Download loops'));
  }
});
