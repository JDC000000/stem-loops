// A4 (2026-11-21), Jon's J1 story: "on my mobile, take a YouTube link and put it in, and very
// quickly be able to listen and learn". Pins, on real modules, rendered markup and a MOUNTED form:
//   1. lib/pending-link.ts: the link carried through sign-in is canonical, nonce-bound, one-shot,
//      bounded in time, claimed atomically across tabs, and nothing in a URL is ever executed;
//   2. the home form, rendered: link box and a 44px Paste button first, no stem picker on phones;
//   3. the home form, MOUNTED (happy-dom, real React effects; PR #332 round 2): the clipboard is
//      read 0 times before the Paste tap; a signed-out link goes to sign-in with 0 job POSTs; the
//      resume strips the marker, checks the session and starts exactly once; signed out, a wrong
//      nonce, or an unknown answer never starts anything; a plain home load only refills the box;
//      fail closed on a 5xx or blocked storage;
//   4. /login: Google first and largest, the email paths folded, exactly one lime action either
//      way, the waiting line with the allowance and "Not your song?", and the saved link cleared
//      on sign-out or on any sign-in that is not its own round trip.
// The real-browser side (taps, y positions, the round trip, the two-tab race) is the j10 journey
// (packages/web-browser-gate/journeys/j10-link-signin-first.mjs) and the PR's race report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './helpers/render-landing-page.mjs';
import { loadLoginForm, loadLoginFormComponent } from './helpers/render-login-form.mjs';
import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';
import {
  IN_FLIGHT_MS, PENDING_LINK_KEY, PENDING_TTL_MS, claimPendingLink, clearPendingLink, hasResumeMarker, isPendingReturnTo,
  markInFlight, newNonce, pendingReturnTo, pendingSignInHref, resumeNonce, savePendingLink, takePendingLink,
} from '../src/lib/pending-link.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = (rel) => readFileSync(join(WEB, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const N1 = 'a'.repeat(32);
const N2 = 'b'.repeat(32);

/** A Storage-shaped map. */
const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
/** A Web Locks stand-in that really serialises callbacks per name, as navigator.locks does. */
const serialLocks = () => {
  const tails = new Map();
  return {
    request(name, cb) {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(() => cb());
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
};
const T0 = 1_800_000_000_000;

// ── 1. lib/pending-link.ts ───────────────────────────────────────────────────────────────

test('pending link: saves only the CANONICAL form of a YouTube link, with a well-formed nonce', () => {
  const s = store();
  assert.equal(savePendingLink(s, 'youtu.be/dQw4w9WgXcQ?si=tracking', N1, T0), true);
  assert.deepEqual(JSON.parse(s.getItem(PENDING_LINK_KEY)), { url: CANON, at: T0, nonce: N1 });
  for (const bad of ['https://example.com/x', 'javascript:alert(1)', 'https://www.youtube.com/playlist?list=PL1', '', '   ']) {
    const t = store();
    assert.equal(savePendingLink(t, bad, N1, T0), false, bad);
    assert.equal(t.getItem(PENDING_LINK_KEY), null, bad);
  }
  for (const n of ['', 'abc', 'A'.repeat(32), 'g'.repeat(32), `${N1}x`]) assert.equal(savePendingLink(store(), CANON, n, T0), false, `nonce ${n}`);
  assert.equal(savePendingLink(null, CANON, N1, T0), false, 'no storage: the caller fails closed');
  // A storage that swallows writes is blocked storage, not a saved link.
  const sink = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  assert.equal(savePendingLink(sink, CANON, N1, T0), false);
  assert.match(newNonce(), /^[0-9a-f]{32}$/);
  assert.notEqual(newNonce(), newNonce());
});

test('pending link: taken ONCE, and only by its own nonce (null = a prefill take, never a start)', () => {
  const s = store();
  savePendingLink(s, CANON, N1, T0);
  assert.equal(takePendingLink(s, N2, T0 + 1000), null, 'another flow\'s nonce');
  assert.equal(s.getItem(PENDING_LINK_KEY), null, 'a wrong nonce still removes the entry');
  savePendingLink(s, CANON, N1, T0);
  assert.equal(takePendingLink(s, N1, T0 + 1000), CANON);
  assert.equal(takePendingLink(s, N1, T0 + 2000), null, 'a second read starts a second job');
  savePendingLink(s, CANON, N1, T0);
  assert.equal(takePendingLink(s, null, T0), CANON, 'prefill take');
  assert.equal(s.getItem(PENDING_LINK_KEY), null);
  const t = store();
  t.setItem(PENDING_LINK_KEY, 'not json');
  assert.equal(takePendingLink(t, null, T0), null);
  assert.equal(t.getItem(PENDING_LINK_KEY), null, 'a bad entry is not left behind');
  savePendingLink(t, CANON, N1, T0);
  clearPendingLink(t);
  assert.equal(t.getItem(PENDING_LINK_KEY), null);
});

test(`pending link: expires after ${PENDING_TTL_MS / 60000} minutes, and a future timestamp is refused`, () => {
  for (const [dt, want] of [[0, true], [PENDING_TTL_MS, true], [PENDING_TTL_MS + 1, false], [-1, false]]) {
    const s = store();
    savePendingLink(s, CANON, N1, T0);
    assert.equal(takePendingLink(s, N1, T0 + dt) !== null, want, `dt=${dt}`);
  }
});

test('pending link: a tampered entry never yields anything but a canonical YouTube URL', () => {
  for (const url of ['https://evil.example/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', `${CANON}&x=1`, 'javascript:alert(1)']) {
    const s = store();
    s.setItem(PENDING_LINK_KEY, JSON.stringify({ url, at: T0, nonce: N1 }));
    assert.equal(takePendingLink(s, N1, T0), null, url);
  }
  for (const e of [{ url: CANON, at: 'now', nonce: N1 }, { url: CANON, at: T0 }, { url: CANON, at: T0, nonce: 7 }]) {
    const s = store();
    s.setItem(PENDING_LINK_KEY, JSON.stringify(e));
    assert.equal(takePendingLink(s, N1, T0), null, JSON.stringify(e));
  }
});

test('pending link: the URL carries only a marker and an opaque nonce, never the link', () => {
  assert.equal(pendingReturnTo(N1), `/?resume=link&n=${N1}`);
  assert.equal(pendingSignInHref(N1), `/login?return_to=${encodeURIComponent(`/?resume=link&n=${N1}`)}`);
  assert.equal(resumeNonce(`?resume=link&n=${N1}`), N1);
  for (const q of ['?resume=link', `?resume=other&n=${N1}`, '?resume=link&n=zz', `?n=${N1}`, '']) assert.equal(resumeNonce(q), null, q);
  assert.equal(hasResumeMarker('?resume=link'), true);
  for (const q of ['', '?resume=1', '?resume=link2', '?x=resume=link']) assert.equal(hasResumeMarker(q), false, q);
  assert.equal(isPendingReturnTo(pendingReturnTo(N1)), true);
  for (const d of ['/account', '/?resume=link', '/jobs/x', `//evil/?resume=link&n=${N1}`]) assert.equal(isPendingReturnTo(d), false, d);
});

test('two tabs: under a Web Lock, two claims of one saved link start it ONCE (50 trials)', async () => {
  for (let i = 0; i < 50; i++) {
    const s = store();
    const locks = serialLocks();
    savePendingLink(s, CANON, N1, Date.now());
    const got = await Promise.all([claimPendingLink({ store: s, nonce: N1, locks }), claimPendingLink({ store: s, nonce: N1, locks })]);
    assert.deepEqual(got.filter(Boolean), [CANON], `trial ${i}: ${JSON.stringify(got)}`);
  }
});

test('two tabs, no Web Locks: the compare-and-delete fallback starts it ONCE (20 trials)', async () => {
  for (let i = 0; i < 20; i++) {
    const s = store();
    savePendingLink(s, CANON, N1, Date.now());
    const got = await Promise.all([claimPendingLink({ store: s, nonce: N1, locks: null }), claimPendingLink({ store: s, nonce: N1, locks: null })]);
    assert.deepEqual(got.filter(Boolean), [CANON], `trial ${i}: ${JSON.stringify(got)}`);
  }
});

test(`in-flight guard: the same link cannot be started twice within ${IN_FLIGHT_MS / 1000} s, even from a second entry`, async () => {
  const s = store();
  const locks = serialLocks();
  savePendingLink(s, CANON, N1, Date.now());
  assert.equal(await claimPendingLink({ store: s, nonce: N1, locks }), CANON);
  savePendingLink(s, CANON, N2, Date.now()); // e.g. a second paste-and-sign-in in another tab
  assert.equal(await claimPendingLink({ store: s, nonce: N2, locks }), null);
  assert.equal(markInFlight(s, CANON, Date.now() + IN_FLIGHT_MS), true, 'after the window it may start again');
});

// ── 2. the home form, rendered ───────────────────────────────────────────────────────────

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
  assert.match(row, /id="paste-btn"[^>]*hidden=""/, 'server render: hidden until the clipboard read is known to exist');
  assert.ok(FORM.indexOf('id="paste-btn"') < FORM.indexOf('id="file-btn"') && FORM.indexOf('id="file-btn"') < FORM.indexOf('id="cta"'));
  assert.equal((FORM.match(/btn-primary/g) ?? []).length, 1, 'lime stays with Separate and play');
  const css = readFileSync(join(WEB, 'src/styles/landing.css'), 'utf8');
  assert.match(css, /\.btn-paste \{[^}]*min-width: 44px/);
  assert.match(css, /\.btn-field \{ height: var\(--h-field\)/);
});

test('home form: no stem picker on phones — no toggle, the chips hidden below 760px, all six sent', () => {
  assert.ok(FORM.includes('id="source"'), 'sanity: the YouTube-enabled form rendered');
  assert.doesNotMatch(FORM, /options-toggle|Change/);
  const css = readFileSync(join(WEB, 'src/styles/landing.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /@media \(max-width: 759px\) \{\s*\.options \{ display: none; \}/);
  assert.match(TOOL_SRC, /const sendStems = isPhone\(\) \? \[\.\.\.STEM_ORDER\] : orderedStems;/);
});

test('home form: the tool note is true: the cap, the trim, the account rule, the rights line', () => {
  const note = FORM.match(/<p class="hint cta-note">([\s\S]*?)<\/p>/)?.[1].replace(/<[^>]*>/g, ' ').replace(/[\s ]+/g, ' ').trim();
  assert.equal(note, 'Uses the first 5 minutes of any song; a longer one is trimmed on our end. Free account to play your own songs. Use audio you have the rights to.');
});

test('home FAQ: the link allowance is disclosed, true to the code (every signed-in link job is metered)', () => {
  const yt = HOME.html.match(/<details id="faq-youtube">([\s\S]*?)<\/details>/)?.[1] ?? '';
  assert.match(yt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), /A song you add from a link uses 1 of your monthly songs\./);
  assert.doesNotMatch(yt, /just like an upload/, 'not true for a signed-out upload (anonymous caps)');
  // The code it describes: every signed-in link path bumps the monthly count.
  const route = readFileSync(join(WEB, 'src/app/api/jobs/route.ts'), 'utf8');
  assert.match(route, /bumpJobsUsedWithinQuota\(client, user\.user_id/);
});

// ── 3. the home form, MOUNTED ────────────────────────────────────────────────────────────

const GRAPH = buildModuleGraph({
  name: 'a4-toolform',
  entries: ['components/landing/ToolForm.tsx'],
  overrides: {
    // The rollout gate on, as in production.
    'lib/public-config.ts': 'export const YOUTUBE_INPUT_ENABLED = true;',
    // No analytics network; the grace is instant.
    'lib/analytics.ts': 'export function trackEvent() {} export const navigationGrace = async () => {};',
  },
  packages: { 'next/navigation': 'export const usePathname = () => null;' },
});
const { ToolForm } = await import(GRAPH.url('components/landing/ToolForm.tsx'));
const React = (await import('react')).default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mount the real form at `url` and return what it did. `me` is the /api/auth/me status (or
 * 'throw'); `cookie` sets a Supabase session cookie; `entry` pre-saves a pending link.
 */
async function mountForm({ url = 'http://localhost:3000/', me = 200, cookie = false, entry = null, storage = 'real', clip = null, after } = {}) {
  return withDom(async (dom) => {
    const w = dom.window;
    const calls = { posts: [], assigns: [], me: 0, readText: 0 };
    if (cookie) w.document.cookie = 'sb-test-auth-token=x';
    if (entry) w.localStorage.setItem(PENDING_LINK_KEY, JSON.stringify(entry));
    // Spy on the REAL clipboard object the form reads (an instance property, not a prototype).
    const clipboard = w.navigator.clipboard;
    clipboard.readText = async () => { calls.readText += 1; return clip ?? ''; };
    const deps = {
      fetch: async (u, init = {}) => {
        if (u === '/api/auth/me') {
          calls.me += 1;
          if (me === 'throw') throw new TypeError('Failed to fetch');
          return new w.Response(JSON.stringify({}), { status: me });
        }
        if (u === '/api/jobs' && init.method === 'POST') {
          calls.posts.push(JSON.parse(init.body));
          return new w.Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }), { status: 201 });
        }
        throw new Error(`unexpected fetch ${u}`);
      },
      assign: (u) => calls.assigns.push(u),
      storage: () => (storage === 'blocked' ? null : w.localStorage),
      locks: () => serialLocks(),
    };
    await dom.mount(React.createElement(ToolForm, { deps }));
    await dom.act(async () => { await sleep(30); });
    calls.readTextOnMount = calls.readText;
    if (after) await after(dom, calls);
    calls.search = w.location.search;
    calls.entry = w.localStorage.getItem(PENDING_LINK_KEY);
    calls.value = dom.find('#source')?.value;
    calls.error = `${dom.find('#job-msg')?.textContent ?? ''} ${dom.find('#source-error')?.textContent ?? ''}`;
    return calls;
  }, { url });
}
const submit = async (dom, value) => {
  const input = dom.find('#source');
  const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await dom.act(async () => {
    set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await dom.act(async () => { dom.find('#tool').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  await dom.act(async () => { await sleep(30); });
};

test('mounted: the clipboard is read 0 times before the Paste tap, once on the tap; a link fills and focuses the button', async () => {
  const r = await mountForm({
    clip: 'https://youtu.be/dQw4w9WgXcQ?si=x',
    after: async (dom, calls) => {
      assert.equal(calls.readText, 0, 'read on load');
      await dom.act(async () => { dom.find('#paste-btn').click(); await sleep(10); });
      assert.equal(calls.readText, 1);
      assert.equal(dom.window.document.activeElement?.id, 'cta');
    },
  });
  assert.equal(r.readTextOnMount, 0);
  assert.equal(r.value, 'https://youtu.be/dQw4w9WgXcQ?si=x');
  assert.equal(r.posts.length, 0, 'Paste never submits');
});

test('mounted: a signed-out LINK goes to sign-in first: 0 job POSTs, the link saved under the return_to nonce', async () => {
  const r = await mountForm({ after: (dom) => submit(dom, 'https://youtu.be/dQw4w9WgXcQ') });
  assert.equal(r.posts.length, 0);
  assert.equal(r.assigns.length, 1);
  const href = new URL(r.assigns[0], 'http://x');
  assert.equal(href.pathname, '/login');
  const nonce = resumeNonce(new URL(href.searchParams.get('return_to'), 'http://x').search);
  assert.ok(nonce, `return_to carries a nonce: ${r.assigns[0]}`);
  assert.deepEqual({ ...JSON.parse(r.entry), at: 0 }, { url: CANON, at: 0, nonce });
  assert.equal(r.me, 0, 'no session cookie: no need to ask the server');
});

test('mounted: signed in (cookie + 200), the link starts here: 1 POST, no sign-in', async () => {
  const r = await mountForm({ cookie: true, after: (dom) => submit(dom, 'https://youtu.be/dQw4w9WgXcQ') });
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].url, CANON);
  assert.deepEqual(r.assigns, ['/jobs/11111111-1111-4111-8111-111111111111']);
});

test('mounted: FAIL CLOSED — a 5xx or no answer from /api/auth/me, or blocked storage, starts no link job', async () => {
  for (const me of [500, 503, 'throw']) {
    const r = await mountForm({ cookie: true, me, after: (dom) => submit(dom, 'https://youtu.be/dQw4w9WgXcQ') });
    assert.equal(r.posts.length, 0, `me=${me}`);
    assert.deepEqual(r.assigns, [], `me=${me}`);
    assert.match(r.error, /We couldn’t check whether you’re signed in\./, `me=${me}`);
  }
  const b = await mountForm({ storage: 'blocked', after: (dom) => submit(dom, 'https://youtu.be/dQw4w9WgXcQ') });
  assert.equal(b.posts.length, 0);
  assert.deepEqual(b.assigns, []);
  assert.match(b.error, /blocking site storage/);
});

const resumeUrl = (n) => `http://localhost:3000/?resume=link&n=${n}`;
const fresh = (nonce = N1) => ({ url: CANON, at: Date.now(), nonce });

test('mounted resume: signed in, the matching nonce starts it ONCE; the marker is stripped and the entry gone', async () => {
  const r = await mountForm({ url: resumeUrl(N1), cookie: true, entry: fresh() });
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].url, CANON);
  assert.equal(r.search, '', `the marker is still in the address bar: ${r.search}`);
  assert.equal(r.entry, null);
  assert.equal(r.me, 1, 'the session is checked before anything starts');
});

test('mounted resume: NOT signed in (401) never starts it — the link goes back in the box', async () => {
  const r = await mountForm({ url: resumeUrl(N1), cookie: true, me: 401, entry: fresh() });
  assert.equal(r.posts.length, 0);
  assert.equal(r.value, CANON);
  assert.equal(r.entry, null);
  assert.equal(r.search, '');
});

test('mounted resume: no session cookie never starts it, and never asks the server', async () => {
  const r = await mountForm({ url: resumeUrl(N1), cookie: false, entry: fresh() });
  assert.equal(r.posts.length, 0);
  assert.equal(r.me, 0);
  assert.equal(r.value, CANON);
});

test('mounted resume: a 5xx on the session check never starts it; the error offers a retry', async () => {
  const r = await mountForm({ url: resumeUrl(N1), cookie: true, me: 502, entry: fresh() });
  assert.equal(r.posts.length, 0);
  assert.equal(r.value, CANON);
  assert.match(r.error, /We couldn’t check whether you’re signed in\./);
});

test('mounted resume: another flow\'s nonce, or a marker with no nonce, starts nothing', async () => {
  const a = await mountForm({ url: resumeUrl(N2), cookie: true, entry: fresh(N1) });
  assert.equal(a.posts.length, 0);
  assert.equal(a.entry, null);
  const b = await mountForm({ url: 'http://localhost:3000/?resume=link', cookie: true, entry: fresh(N1) });
  assert.equal(b.posts.length, 0);
  assert.equal(b.search, '');
});

test('mounted: a plain home load (no marker) only refills the box — and clears the saved link', async () => {
  const r = await mountForm({ cookie: true, entry: fresh() });
  assert.equal(r.posts.length, 0);
  assert.equal(r.me, 0);
  assert.equal(r.value, CANON, 'Back from /login keeps the link in the box');
  assert.equal(r.entry, null, 'the link can never start later for whoever signs in next');
});

test('mounted: a replayed marker (entry already used) starts nothing', async () => {
  const r = await mountForm({ url: resumeUrl(N1), cookie: true, entry: null });
  assert.equal(r.posts.length, 0);
});

// ── 4. /login ─────────────────────────────────────────────────────────────────────────────

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
    // (happy-dom keeps a stale `background` shorthand when React swaps style objects; Chromium
    // does not — the background swap is checked there, see the PR.)
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

test('/login: a waiting link says so, with the allowance, and offers "Not your song?"; other visits do not', async () => {
  const render = await loadLoginForm();
  const html = render({ returnTo: pendingReturnTo(N1) });
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Sign in and your song starts straight away\. It uses 1 of your monthly songs\./);
  assert.match(html, /data-testid="login-link-drop"[^>]*>Not your song\? Sign in without it</);
  for (const returnTo of [undefined, '/account', '/jobs/477fb242-695a-4b29-9373-a26b9067a8fa', '/?resume=link', '/?resume=other']) {
    assert.doesNotMatch(render({ returnTo }), /login-link-waiting/, String(returnTo));
  }
});

test('/login: "Not your song?" clears the saved link and the marker; the sign-in then goes home', async () => {
  const { React: R, Form } = await loadLoginFormComponent();
  await withDom(async (dom) => {
    dom.window.localStorage.setItem(PENDING_LINK_KEY, JSON.stringify(fresh()));
    await dom.mount(R.createElement(Form, { returnTo: pendingReturnTo(N1) }));
    await dom.act(() => dom.find('[data-testid="login-link-drop"]').click());
    assert.equal(dom.window.localStorage.getItem(PENDING_LINK_KEY), null);
    assert.equal(dom.find('[data-testid="login-link-waiting"]'), null);
  });
});

test('/login: a different user signing in (not this round trip) or a sign-out clears the saved link', async () => {
  const { React: R, Form } = await loadLoginFormComponent();
  let cb = null;
  globalThis.__loginStub = { onAuth: (f) => { cb = f; } };
  try {
    for (const [props, event, kept] of [
      [{ returnTo: '/account' }, 'SIGNED_IN', false], // another person's ordinary sign-in on this device
      [{}, 'SIGNED_IN', false],
      [{ returnTo: pendingReturnTo(N1) }, 'SIGNED_OUT', false],
      [{ returnTo: pendingReturnTo(N1) }, 'SIGNED_IN', true], // its own round trip: the home form claims it
    ]) {
      await withDom(async (dom) => {
        dom.window.localStorage.setItem(PENDING_LINK_KEY, JSON.stringify(fresh()));
        await dom.mount(R.createElement(Form, props));
        assert.ok(cb, 'the form subscribed to auth changes');
        await dom.act(() => cb(event, null)); // null session: no navigation in this harness
        assert.equal(dom.window.localStorage.getItem(PENDING_LINK_KEY) !== null, kept, `${JSON.stringify(props)} ${event}`);
      });
    }
  } finally {
    delete globalThis.__loginStub;
  }
});

test('account deletion signs out and clears the saved link too', () => {
  const src = code('src/components/DeleteAccountForm.tsx');
  assert.match(src, /clearPendingLink\(window\.localStorage\);[\s\S]*auth\.signOut\(\{ scope: 'local' \}\)/);
});
