// A4 (2026-11-21), Jon's J1 story: "on my mobile, take a YouTube link and put it in, and very
// quickly be able to listen and learn". Pins, on real modules and rendered markup:
//   1. lib/pending-link.ts: the link carried through sign-in is canonical, one-shot, bounded in
//      time, and nothing in a URL is ever executed;
//   2. the home form: link box and a 44px Paste button first, no stem picker on phones, the
//      clipboard is read only inside the Paste tap, and a signed-out LINK signs in first;
//   3. /login: Google first and largest, the email paths folded under "Use email instead",
//      exactly one lime action either way, and the "your song starts" line for a waiting link.
// The real-browser side (taps, y positions, the full round trip with the API mocked) was run in
// Chromium at 390x844 and 360x800 and is reported in the PR with screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderPage } from './helpers/render-landing-page.mjs';
import { loadLoginForm, loadLoginFormComponent } from './helpers/render-login-form.mjs';
import { withDom } from './helpers/dom.mjs';
import {
  PENDING_LINK_KEY, PENDING_RETURN_TO, PENDING_TTL_MS, hasResumeMarker, pendingSignInHref, savePendingLink, takePendingLink,
} from '../src/lib/pending-link.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = (rel) => readFileSync(join(WEB, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A Storage-shaped map. */
const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const T0 = 1_800_000_000_000;

// ── 1. lib/pending-link.ts ───────────────────────────────────────────────────────────────

test('pending link: saves only the CANONICAL form of a YouTube link, and nothing else', () => {
  const s = store();
  assert.equal(savePendingLink(s, 'youtu.be/dQw4w9WgXcQ?si=tracking', T0), true);
  assert.deepEqual(JSON.parse(s.getItem(PENDING_LINK_KEY)), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', at: T0 });
  for (const bad of ['https://example.com/x', 'javascript:alert(1)', 'https://www.youtube.com/playlist?list=PL1', '', '   ']) {
    const t = store();
    assert.equal(savePendingLink(t, bad, T0), false, bad);
    assert.equal(t.getItem(PENDING_LINK_KEY), null, bad);
  }
  assert.equal(savePendingLink(null, 'https://youtu.be/dQw4w9WgXcQ', T0), false, 'no storage: the caller starts signed out instead');
});

test('pending link: taken ONCE — the entry is removed on the first read, valid or not', () => {
  const s = store();
  savePendingLink(s, 'https://youtu.be/dQw4w9WgXcQ', T0);
  assert.equal(takePendingLink(s, T0 + 1000), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(s.getItem(PENDING_LINK_KEY), null);
  assert.equal(takePendingLink(s, T0 + 2000), null, 'a second read starts a second job');
  const t = store();
  t.setItem(PENDING_LINK_KEY, 'not json');
  assert.equal(takePendingLink(t, T0), null);
  assert.equal(t.getItem(PENDING_LINK_KEY), null, 'a bad entry is not left behind');
});

test(`pending link: expires after ${PENDING_TTL_MS / 60000} minutes, and a future timestamp is refused`, () => {
  for (const [dt, want] of [[0, true], [PENDING_TTL_MS, true], [PENDING_TTL_MS + 1, false], [-1, false]]) {
    const s = store();
    savePendingLink(s, 'https://youtu.be/dQw4w9WgXcQ', T0);
    assert.equal(takePendingLink(s, T0 + dt) !== null, want, `dt=${dt}`);
  }
});

test('pending link: a tampered entry never yields anything but a canonical YouTube URL', () => {
  for (const url of [
    'https://evil.example/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ', // a YouTube link, but not the canonical form this module writes
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=1',
    'javascript:alert(1)',
  ]) {
    const s = store();
    s.setItem(PENDING_LINK_KEY, JSON.stringify({ url, at: T0 }));
    assert.equal(takePendingLink(s, T0), null, url);
  }
  const s = store();
  s.setItem(PENDING_LINK_KEY, JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', at: 'now' }));
  assert.equal(takePendingLink(s, T0), null, 'a non-numeric time');
});

test('pending link: the URL carries only a marker, never the link', () => {
  assert.equal(PENDING_RETURN_TO, '/?resume=link');
  assert.equal(pendingSignInHref(), '/login?return_to=%2F%3Fresume%3Dlink');
  assert.equal(hasResumeMarker('?resume=link'), true);
  for (const s of ['', '?resume=1', '?resume=link2', '?x=resume=link', '?link=https://youtu.be/dQw4w9WgXcQ']) assert.equal(hasResumeMarker(s), false, s);
});

// ── 2. the home form ─────────────────────────────────────────────────────────────────────

// The link box renders only with the YouTube rollout gate on (lib/public-config.ts), as in
// production; the test render turns it on at its one definition.
const HOME = await renderPage('app/(landing)/page.tsx', {
  patch: (rel, src) => (rel === join('lib', 'public-config.ts')
    ? src.replace("process.env.NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT === 'true'", 'true')
    : src),
});
const FORM = HOME.html.match(/<form\b[^>]*id="tool"[\s\S]*?<\/form>/)?.[0] ?? '';
const TOOL_SRC = code('src/components/landing/ToolForm.tsx');

test('home form: the link box and the Paste button share the first row; the file picker is one row down', () => {
  assert.ok(FORM, 'no tool form');
  const row = FORM.match(/<div class="source" id="source-wrap">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(row, /<input id="source"/);
  assert.match(row, /<button type="button" id="paste-btn" class="btn btn-secondary btn-field btn-paste"[^>]*>Paste<\/button>/);
  // Server render: hidden until the browser is known to support the clipboard read.
  assert.match(row, /id="paste-btn"[^>]*hidden=""/);
  assert.ok(FORM.indexOf('id="paste-btn"') < FORM.indexOf('id="file-btn"') && FORM.indexOf('id="file-btn"') < FORM.indexOf('id="cta"'));
  // Paste is secondary: the one lime fill stays with Separate and play.
  assert.equal((FORM.match(/btn-primary/g) ?? []).length, 1);
  // 44px floor: .btn-field is --h-field (48px); the Paste rule keeps a 44px minimum width.
  const css = readFileSync(join(WEB, 'src/styles/landing.css'), 'utf8');
  assert.match(css, /\.btn-paste \{[^}]*min-width: 44px/);
  assert.match(css, /\.btn-field \{ height: var\(--h-field\)/);
});

test('home form: the clipboard is read ONLY inside the Paste tap handler', () => {
  const reads = [...TOOL_SRC.matchAll(/readText\(\)/g)];
  assert.equal(reads.length, 1, 'one read');
  const onPaste = /async function onPaste\(\) \{([\s\S]*?)\n  \}\n/.exec(TOOL_SRC)?.[1] ?? '';
  assert.match(onPaste, /navigator\.clipboard\.readText\(\)/, 'the read is in onPaste');
  assert.match(TOOL_SRC, /onClick=\{\(\) => void onPaste\(\)\}/, 'onPaste is wired to the tap');
  // Feature check after mount reads `typeof navigator.clipboard?.readText`, never calls it.
  assert.match(TOOL_SRC, /typeof navigator\.clipboard\?\.readText === 'function'/);
  // A YouTube link is filled in and the focus goes to the button.
  assert.match(onPaste, /canonicalizeYoutubeUrl\(t\)/);
  assert.match(onPaste, /focusNext\.current = 'cta'/);
});

test('home form: no stem picker on phones — no toggle, the chips hidden below 760px, all six sent', () => {
  assert.ok(FORM.includes('id="source"'), 'sanity: the YouTube-enabled form rendered');
  assert.doesNotMatch(FORM, /options-toggle|Change/);
  const css = readFileSync(join(WEB, 'src/styles/landing.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /@media \(max-width: 759px\) \{\s*\.options \{ display: none; \}/);
  assert.match(TOOL_SRC, /const PHONE_QUERY = '\(max-width: 759px\)';/);
  assert.match(TOOL_SRC, /const sendStems = isPhone\(\) \? \[\.\.\.STEM_ORDER\] : orderedStems;/);
});

test('home form: a signed-out LINK signs in first; a file still starts signed out', () => {
  const submit = /function onSubmit\(e: React\.FormEvent\) \{([\s\S]*?)\n  \}\n/.exec(TOOL_SRC)?.[1] ?? '';
  assert.match(submit, /if \(canonical\) void submitLink\(canonical, sendStems\);\s*else void runJob\(null, sendStems\);/);
  const signIn = /async function signInFirst\(canonical: string\): Promise<boolean> \{([\s\S]*?)\n  \}\n/.exec(TOOL_SRC)?.[1] ?? '';
  // Order matters: ask the server, save the link, THEN leave. No job is POSTed on this path.
  const i = signIn.indexOf('signedInNow()');
  const j = signIn.indexOf('savePendingLink(');
  const k = signIn.indexOf('window.location.assign(pendingSignInHref())');
  assert.ok(i > -1 && i < j && j < k, 'signInFirst must check the session, save the link, then go to /login');
  assert.doesNotMatch(signIn, /\/api\/jobs/);
  // The session check: no cookie -> signed out; a cookie -> the server decides (401 = signed out).
  const check = /async function signedInNow\(\)[\s\S]*?\n\}\n/.exec(TOOL_SRC)?.[0] ?? '';
  assert.match(check, /if \(!hasSessionCookie\(cookie\)\) return false;/);
  assert.match(check, /fetch\('\/api\/auth\/me'/);
  assert.match(check, /if \(res\.status === 401\) return false;/);
});

test('home form: back from sign-in, the saved link is taken once and the marker is stripped first', () => {
  const effect = /const resumed = useRef\(false\);([\s\S]*?)\n  \}, \[\]\);/.exec(TOOL_SRC)?.[1] ?? '';
  assert.ok(effect, 'no resume effect');
  const strip = effect.indexOf('replaceState');
  const take = effect.indexOf('takePendingLink(');
  const run = effect.indexOf('runJob(link');
  assert.ok(strip > -1 && strip < take && take < run, 'strip the marker, take the link, then start it');
  assert.match(effect, /if \(!hasResumeMarker\(search\)\) return;/);
  // Never anything from the URL: the link comes from takePendingLink only.
  assert.doesNotMatch(effect, /searchParams\.get\(/);
});

test('home form: the tool note is phone-first and true: the cap, the trim, the account rule, the rights line', () => {
  const note = FORM.match(/<p class="hint cta-note">([\s\S]*?)<\/p>/)?.[1].replace(/<[^>]*>/g, ' ').replace(/[\s ]+/g, ' ').trim();
  assert.equal(note, 'Uses the first 5 minutes of any song; a longer one is trimmed on our end. Free account to play your own songs. Use audio you have the rights to.');
});

// ── 3. /login ─────────────────────────────────────────────────────────────────────────────

const limeCount = (html) => (html.match(/background:var\(--accent\)/g) ?? []).length;

test('/login: Google is first and largest, the email paths are folded, and there is one lime action', async () => {
  const render = await loadLoginForm();
  const html = render({});
  const google = html.indexOf('data-testid="login-google"');
  assert.ok(google > -1);
  assert.ok(google < html.indexOf('type="email"'), 'Google comes before the email field');
  assert.ok(google < html.indexOf('Email me a one-time link'));
  assert.match(html, /data-testid="login-google"[^>]*style="[^"]*min-height:56px/);
  assert.match(html, /aria-expanded="false" aria-controls="login-email"[^>]*>Use email instead</);
  assert.match(html, /<div id="login-email" hidden=""/);
  assert.equal(limeCount(html), 1, 'one lime action on the folded view');
  assert.match(html, /data-testid="login-google"[^>]*background:var\(--accent\)/, 'and it is Google');
});

test('/login: the email options open on a tap, and the lime moves to the email form', async () => {
  const { React: R, Form } = await loadLoginFormComponent();
  await withDom(async (dom) => {
    await dom.mount(R.createElement(Form, {}));
    await dom.act(() => dom.find('[data-testid="login-email-toggle"]').click());
    assert.equal(dom.find('#login-email').hidden, false);
    assert.equal(dom.find('[data-testid="login-email-toggle"]').getAttribute('aria-expanded'), 'true');
    // Read by the TEXT colour: every lime button (primaryButton) carries --text-inverse text.
    // (happy-dom keeps a stale `background` shorthand when React swaps style objects; Chromium does
    // not — the background swap was checked there, see the PR.)
    const lime = dom.findAll('button').filter((b) => /color: var\(--text-inverse\)/.test(b.getAttribute('style') ?? ''));
    assert.deepEqual(lime.map((b) => b.textContent.trim()), ['Sign in'], 'one lime action, the email form\'s own');
  });
});

test('/login: an email path or an error opens the email options from the start', async () => {
  const render = await loadLoginForm();
  for (const props of [{ initialMode: 'signup' }, { initialMode: 'reset' }, { initialError: 'auth_callback_failed' }]) {
    const html = render(props);
    assert.doesNotMatch(html, /<div id="login-email" hidden=""/, JSON.stringify(props));
    assert.equal(limeCount(html), 1, JSON.stringify(props));
  }
});

test('/login: a link waiting to start says so; other visits do not', async () => {
  const render = await loadLoginForm();
  assert.match(render({ returnTo: PENDING_RETURN_TO }), /data-testid="login-link-waiting"[^>]*>Sign in and your song starts straight away\./);
  for (const returnTo of [undefined, '/account', '/jobs/477fb242-695a-4b29-9373-a26b9067a8fa', '/?resume=other']) {
    assert.doesNotMatch(render({ returnTo }), /login-link-waiting/, String(returnTo));
  }
});

void React;
