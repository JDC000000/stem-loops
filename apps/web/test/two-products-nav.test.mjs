// TWO PRODUCTS, ONE TOP NAV (2026-11-15).
//
// Jon: "on the home page ... stem downloads would be removed from the play along section. It's
// just up on the top nav. I don't see it up on the top nav. It's a full separate product
// available in the top nav on a separate user page." And (Sunday decisions): "Download loops is
// a SEPARATE PRODUCT in the top nav on every page INCLUDING the landing page; the play-along
// landing does not sell stem/loop downloads."
//
// What this file pins, on RENDERED markup (the repo's rule; see test/helpers/render-landing-page.mjs):
//   1. the marketing pages (landing, /terms, /privacy, 404) render THE SAME nav as the app pages,
//      with Download loops in it; the old marketing-only bar is gone;
//   2. the landing marks Play along as the current product;
//   3. the landing's body sells no loop or stem downloads (two named, frozen exceptions below);
//   4. /loops, signed out, is a product page with sign-in one click on and a return path;
//   5. /loops is public for SEO: in the registry, the sitemap and llms.txt, indexable;
//   6. on the statically rendered pages the last item becomes "Account" only from a session
//      cookie hint, and never overrides a server-resolved session.
// The signed-in routes' nav (every layout, every session state) is pinned by
// test/signed-in-nav.test.mjs, which renders the real layout chains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { landingPage, renderPage } from './helpers/render-landing-page.mjs';
import { compile, navigationStub, toMarkup } from './helpers/render-chrome.mjs';
import { withDom } from './helpers/dom.mjs';
import sitemap from '../src/app/sitemap.ts';
import { llmsText } from '../src/lib/seo/llms.ts';
import { pageFor } from '../src/lib/seo/pages.ts';

const links = (html) =>
  [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    attrs: m[1],
    href: m[1].match(/href="([^"]*)"/)?.[1] ?? null,
    text: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
  }));
const headerOf = (html) => html.match(/<header class="sin-bar"[\s\S]*?<\/header>/)?.[0] ?? null;
const navItems = (html) =>
  links(headerOf(html) ?? '')
    .filter((l) => /class="[^"]*sin-item/.test(l.attrs))
    .map((l) => l.text);
const currentItems = (html) =>
  links(headerOf(html) ?? '')
    .filter((l) => /aria-current="page"/.test(l.attrs))
    .map((l) => l.text);
const productTag = (html) => html.match(/data-testid="sin-product"[^>]*>([\s\S]*?)<\/span>/)?.[1].trim() ?? null;

// ═══ 1–2. The marketing pages carry the one nav ═══════════════════════════════════════════

const MARKETING = [
  ['/', 'app/(landing)/page.tsx', 'Play along'],
  ['/terms', 'app/(landing)/terms/page.tsx', null],
  ['/privacy', 'app/(landing)/privacy/page.tsx', null],
  ['404', 'app/not-found.tsx', null],
];

for (const [route, file, current] of MARKETING) {
  test(`${route}: renders the shared top nav with both products, Download loops → /loops`, async () => {
    const { html } = route === '/' ? await landingPage() : await renderPage(file);
    const header = headerOf(html);
    assert.ok(header, `${route} has no .sin-bar header`);
    assert.ok(!/class="site-header"/.test(html), `${route} still renders the old marketing-only bar`);
    assert.deepEqual(navItems(html), ['Play along', 'Download loops', 'Song library', 'Pricing', 'Sign in']);
    assert.equal(links(header).find((l) => l.text === 'Pricing')?.href, '/pricing');
    const dl = links(header).find((l) => l.text === 'Download loops');
    assert.equal(dl.href, '/loops');
    assert.equal(links(header).find((l) => l.text === 'Play along').href, '/');
    // Exactly one header per page: the nav replaced the old bar, it did not join it.
    assert.equal((html.match(/<header\b/g) ?? []).length, 1, `${route} renders more than one <header>`);
    // No router here, so usePathname() is null and nothing is marked: the current-item and
    // product-tag behaviour for these paths is pinned with a stubbed pathname in
    // test/signed-in-nav.test.mjs ('/' → Play along) and in section 6 below.
    assert.deepEqual(currentItems(html), []);
    void current;
  });
}

// S4 (IA review of #280), revised by P6 (Jon, 2026-11-17). Pricing was kept out of the top nav
// because F31 (2026-11-13) allowed the landing exactly one /pricing link. P6 puts "Pricing" in
// the top nav on every page, so the landing now carries exactly TWO: the nav item (in the
// .sin-bar header, labelled "Pricing") and the scope sheet's link in the page body. It is still
// NOT in the shared marketing footer, which lists the two products only.
test('S4/P6: the landing carries exactly two /pricing links — the nav item and the scope sheet', async () => {
  const { html } = await landingPage();
  assert.equal((html.match(/href="\/pricing/g) ?? []).length, 2);
  const header = html.match(/<header\b[^>]*class="sin-bar"[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.deepEqual(links(header).filter((l) => l.href === '/pricing').map((l) => l.text), ['Pricing']);
  const body = html.replace(header, '');
  assert.equal((body.match(/href="\/pricing/g) ?? []).length, 1, 'outside the nav, only the scope sheet links /pricing');
});

test('the marketing footer lists the two products as peers', async () => {
  const { html } = await landingPage();
  const nav = html.match(/<nav class="footer-links" aria-label="Products">[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav, 'no Products nav in the footer');
  assert.deepEqual(
    links(nav).map((l) => [l.text, l.href]),
    [
      ['Play along', '/'],
      ['Download loops', '/loops'],
    ],
  );
});

// ═══ 3. The landing sells Play along only ═════════════════════════════════════════════════
//
// The ban list reads the landing's <main> as rendered, in both normalisations. The header and
// footer are outside <main> and are ALLOWED to name Download loops: that is the point.
//
// ONE FROZEN EXCEPTION, stated rather than hidden: the hero's example lanes, whose measured
// captions (drift, beat alignment) are the demo-asset contract and describe the loop cut. The
// tool form's "Loop length" picker and its "N-bar loops" summary are GONE (review of #280, B1):
// the form sends no length and the API's default of 4 bars applies. The exception is pinned to
// exactly that one element, so it cannot quietly grow.
const SELLING = [
  /\bdownload(?:ing)?\s+(?:the\s+)?loops?\b/i,
  /\bloop\s+files?\b/i,
  /\bbar-length\s+loops?\b/i,
  /\btake\s+the\s+loops\s+home\b/i,
  /\bcut\s+and\s+download\b/i,
  /\bpress\s+Cut\b/i,
  /\.wav\b/i,
  /\b24[\s‑-]?bit\b/i,
  /\bWAV\s+files?\b/i,
  /\bsample\s+folder\b/i,
  /\bin\s+your\s+DAW\b/i,
  /\bloops?\s+commercially\b/i,
];

async function landingMainWithoutExceptions() {
  const { html } = await landingPage();
  let removed = [];
  await withDom(async (dom) => {
    const doc = dom.window.document;
    const holder = doc.createElement('div');
    holder.innerHTML = html;
    const main = holder.querySelector('main');
    assert.ok(main, 'the landing has no <main>');
    for (const sel of ['section.lanes']) {
      for (const el of main.querySelectorAll(sel)) {
        removed.push(sel);
        el.remove();
      }
    }
    removed.mainHtml = main.innerHTML;
  });
  return removed;
}

test('the landing body sells no loop or stem downloads (outside the two frozen exceptions)', async () => {
  const removed = await landingMainWithoutExceptions();
  const html = removed.mainHtml;
  for (const [name, text] of [
    ['spaced', html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ')],
    ['tight', html.replace(/<[^>]*>/g, '').replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ')],
  ]) {
    for (const re of SELLING) assert.doesNotMatch(text, re, `landing <main> (${name}) still sells loops: ${re}`);
  }
  assert.ok(!/id="loops"/.test(html), 'the #loops section is back on the landing');
  assert.ok(!/class="file-card"/.test(html), 'the loop file card is back on the landing');
});

test('the frozen exception is exactly the example lanes, and nothing else', async () => {
  const removed = await landingMainWithoutExceptions();
  // Matched exactly once: if the lanes are reworked, this goes red and the list shrinks.
  assert.deepEqual([...removed], ['section.lanes']);
});

test('B1: the Play along form neither shows nor sends a loop length', async () => {
  const { html } = await landingPage();
  const form = html.match(/<form\b[^>]*id="tool"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form, 'no tool form');
  const text = form.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /loop length|\bbar loops\b|-bar loops|\b[1248]\s*bars?\b|per stem/i, text);
  assert.ok(!/id="length-group"|name="bars"/.test(form), 'the loop-length control is back');
  // And the POST bodies: the source is the only place the request shape lives (a client
  // handler never runs under renderToStaticMarkup), comments stripped.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/components/landing/ToolForm.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /loop_length_bars/, 'ToolForm still sends a loop length');
  assert.doesNotMatch(src, /\bsetBars\b|BAR_OPTIONS/, 'ToolForm still offers a loop length');
});

test('CANARY: the selling ban list matches the copy it exists to keep off the landing', () => {
  const old = [
    'You can still take the loops home.',
    'Every song also gets bar-length loops, for anyone who came here to build a sample folder rather than to practise.',
    'Open Download loops, pick the song and press Cut to make the WAV files.',
    'lucky_ticket_drums_102.0bpm_G_minor_verse_0006.wav',
    'Loop files 24-bit WAV, 44.1 kHz',
    'You also get bar-length loops from each stem to cut and download.',
    'Can I use the loops commercially?',
  ];
  for (const s of old) assert.ok(SELLING.some((re) => re.test(s)), `nothing in the ban list matches: ${s}`);
  // …and the play-along copy that must stay does not trip it.
  for (const s of ['loop a section until it sticks', 'a loop you can set on any detected section of the song', 'Looping'])
    assert.ok(!SELLING.some((re) => re.test(s)), `false positive on: ${s}`);
});

// ═══ 4. /loops signed out: a product page, not a dead end ═════════════════════════════════

async function intro() {
  const [url] = compile(['components/loops/LoopsIntro.tsx']);
  const mod = await import(`${url}?${Math.random()}`);
  return { html: await toMarkup(React.createElement(mod.default)), mod };
}

test('/loops intro: names the product, links sign-in with a return path to /loops, and links back to Play along', async () => {
  const { html, mod } = await intro();
  assert.match(html, /<h1 class="lp-h1">Download loops<\/h1>/);
  assert.equal(mod.LOOPS_SIGN_IN_HREF, '/login?return_to=%2Floops');
  const l = links(html);
  const cta = l.find((x) => x.text === 'Sign in to download loops');
  assert.ok(cta, 'no sign-in call to action');
  assert.equal(cta.href.replace(/&amp;/g, '&'), '/login?return_to=%2Floops');
  assert.ok(l.some((x) => x.href === '/' && /Play along/.test(x.text)), 'no way to Play along from the intro');
  // It says what the product is and the truths that moved off the landing.
  const flat = html.replace(/&nbsp;|\u00a0/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  for (const re of [/24-bit WAV/, /44\.1/, /\b4 bars, up to 10 loops per stem/, /fixed when the song is split/, /Nudge it in your DAW/, /need clearance/, /separate tool from Play along/i]) {
    assert.match(flat, re);
  }
  // The example is 8 bars (the only WAV the demo host has); the page must say so next to it.
  if (/lp-file-name/.test(html)) {
    assert.match(flat, /This example is 8 bars long, from an earlier run\. Loops you cut here are 4 bars\./);
  }
  // B2: no claim of a length choice the cutter does not offer.
  assert.doesNotMatch(flat, /1, 2, 4 or 8|choose its loops|pick (?:a|the) length/i);
  // S2: the 5-minute rule, from the player cap.
  const { MAX_TRACK_SEC } = await import('../src/lib/play/types.ts');
  assert.match(flat, new RegExp(`first ${Math.floor(MAX_TRACK_SEC / 60)} minutes of the song`));
  assert.doesNotMatch(flat, /\bup to \d+ minutes\b|\brefused\b/i);
  // S1: plan-aware retention, worded as PR #279's landing FAQ.
  const when = html.match(/data-testid="loops-intro-retention"[^>]*>([\s\S]*?)<\/dd>/)[1].replace(/\s+/g, ' ');
  assert.match(when, /On Free, that is 24 hours from splitting it\./);
  assert.match(when, /kept as a library while you subscribe, and for 30 days after it ends\./);
  // N5: an indexable product page has the site's footer links.
  const foot = html.match(/<footer[^>]*data-testid="loops-intro-footer"[\s\S]*?<\/footer>/)?.[0] ?? '';
  assert.deepEqual(links(foot).map((x) => x.href), ['/', '/loops', '/pricing', '/terms', '/privacy']);
  assert.ok(!/<main[\s\S]*<footer[\s\S]*<\/main>/.test(html), 'the footer belongs outside <main>');
  // A signed-out page shows no song, no job and no API wiring.
  assert.doesNotMatch(html, /\/api\//);
  assert.doesNotMatch(html, /\/jobs\//);
});

test('/loops intro: the account sentence keeps the brand truth (new visitors create an account on the sign-in page)', async () => {
  const { html } = await intro();
  assert.match(html, /If you are new, you create an account on the sign-in page\./);
  assert.doesNotMatch(html, /\bno account\b|\bwithout an account\b|\bcreates one\b/i);
});

// ═══ 5. SEO: /loops is a public, indexable page ═══════════════════════════════════════════

test('/loops is in the page registry, the sitemap and llms.txt', () => {
  const p = pageFor('/loops');
  assert.ok(p, '/loops is not in lib/seo/pages.ts');
  assert.equal(p.published, true);
  assert.equal(p.title, 'Download loops');
  assert.ok(sitemap().some((e) => e.url === 'https://stem-loops.com/loops'), 'sitemap omits /loops');
  assert.match(llmsText(), /\[Download loops\]\(https:\/\/stem-loops\.com\/loops\)/);
});

test('/loops layout metadata is indexable, canonical /loops, from the registry entry', async () => {
  const [url] = compile(['app/loops/layout.tsx'], {
    '@/components/chrome/SignedInChrome': 'export default function SignedInChrome() { return null; }',
  });
  const mod = await import(`${url}?${Math.random()}`);
  assert.equal(mod.metadata.robots, undefined, '/loops is still noindex');
  assert.equal(mod.metadata.alternates.canonical, '/loops');
  assert.equal(mod.metadata.title, 'Download loops');
  assert.equal(mod.metadata.description, pageFor('/loops').description);
  assert.equal(mod.dynamic, 'force-dynamic', 'the bar is session-aware; the segment must stay dynamic');
});

// ═══ 6. The last item on statically rendered pages ════════════════════════════════════════

async function navModule(path = '/') {
  const [url] = compile(['components/chrome/SignedInNav.tsx'], { 'next/navigation': navigationStub(path) });
  return import(`${url}?${Math.random()}`);
}

test('hasSessionCookie: recognises a Supabase auth cookie (plain or chunked) and nothing else', async () => {
  const { hasSessionCookie } = await navModule();
  for (const yes of ['sb-abcd-auth-token=x', 'a=1; sb-abcd-auth-token.0=x', 'sb-x-y-auth-token=base64-eyJ']) assert.ok(hasSessionCookie(yes), yes);
  for (const no of ['', 'sl-history=abc', 'sb-abcd-auth-token=', 'sb-abcd-auth-token-code-verifier=x', 'xsb-a-auth-token=1'])
    assert.ok(!hasSessionCookie(no), no);
});

test('static pages: "Sign in" by default, "Account" once a session cookie is present', async () => {
  const { default: Nav } = await navModule('/');
  for (const [cookie, want] of [
    [null, 'Sign in'],
    ['sb-ref-auth-token=x', 'Account'],
  ]) {
    await withDom(async (dom) => {
      if (cookie) dom.window.document.cookie = cookie;
      await dom.mount(React.createElement(Nav, { signedIn: null }));
      const items = dom.findAll('a.sin-item').map((a) => a.textContent.trim());
      assert.equal(items.at(-1), want, `cookie=${cookie}`);
      assert.equal(dom.find('a.sin-item[aria-current="page"]')?.textContent.trim(), 'Play along');
    });
  }
});

test('a server-resolved session always wins over the cookie hint', async () => {
  const { default: Nav } = await navModule('/account');
  await withDom(async (dom) => {
    dom.window.document.cookie = 'sb-ref-auth-token=x';
    await dom.mount(React.createElement(Nav, { signedIn: false }));
    assert.equal(dom.findAll('a.sin-item').at(-1).textContent.trim(), 'Sign in');
  });
  const html = await toMarkup(React.createElement(Nav, { signedIn: true }));
  assert.equal(navItems(html).at(-1), 'Account');
});

// ═══ 7. Review of #280: the hint is really wired, the menu closes, sign-in comes back ══════

test('N1: SiteHeader (what every static page renders) shows "Account" from a session cookie', async () => {
  const [url] = compile(['components/landing/SiteChrome.tsx'], { 'next/navigation': navigationStub('/terms') });
  const { SiteHeader } = await import(`${url}?${Math.random()}`);
  for (const [cookie, want] of [
    [null, 'Sign in'],
    ['sb-ref-auth-token=x', 'Account'],
  ]) {
    await withDom(async (dom) => {
      if (cookie) dom.window.document.cookie = cookie;
      await dom.mount(React.createElement(SiteHeader));
      assert.equal(dom.findAll('a.sin-item').at(-1).textContent.trim(), want, `cookie=${cookie}`);
    });
  }
});

test('N1: the static pages stay static — no session read, no dynamic export', async () => {
  const { readFileSync } = await import('node:fs');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['app/(landing)/layout.tsx', 'app/(landing)/page.tsx', 'app/(landing)/terms/page.tsx', 'app/(landing)/privacy/page.tsx', 'app/not-found.tsx', 'components/landing/SiteChrome.tsx']) {
    const src = strip(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /SignedInChrome|@\/lib\/auth|next\/headers|export const dynamic/, `${f} reads the session or opts out of static rendering`);
  }
});

test('N2: Escape closes the phone menu and returns focus to the toggle', async () => {
  const { default: Nav } = await navModule('/');
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Nav, { signedIn: null }));
    const toggle = dom.find('.sin-toggle');
    await dom.act(() => toggle.click());
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    await dom.act(() => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'Escape did not close the menu');
    assert.ok(!dom.find('#sin-menu').className.includes('sin-open'));
    assert.equal(dom.window.document.activeElement, toggle, 'focus did not return to the toggle');
    // Another key does nothing.
    await dom.act(() => toggle.click());
    await dom.act(() => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  });
});

test('N3: on /loops the nav Sign in returns to /loops; elsewhere it is plain /login', async () => {
  const { default: OnLoops } = await navModule('/loops');
  const l = links(await toMarkup(React.createElement(OnLoops, { signedIn: false })));
  assert.equal(l.find((x) => x.text === 'Sign in').href.replace(/&amp;/g, '&'), '/login?return_to=%2Floops');
  const { default: OnTerms } = await navModule('/terms');
  assert.equal(links(await toMarkup(React.createElement(OnTerms, { signedIn: false }))).find((x) => x.text === 'Sign in').href, '/login');
});

test('the landing example lanes draw no loop bracket', async () => {
  const { html } = await landingPage();
  const lanes = html.match(/<section[^>]*class="lanes[\s\S]*?<\/section>/)?.[0];
  assert.ok(lanes, 'no example lanes rendered');
  assert.ok(!/class="bracket"/.test(lanes), 'the loop bracket is back on the Play along landing');
});
