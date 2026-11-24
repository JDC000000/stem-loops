// Vercel Web Analytics (decision 2A) — layout mount, CSP fit, and the no-PII event contract.
//
//   1. The ROOT LAYOUT renders <SiteAnalytics />, and SiteAnalytics renders the real
//      `@vercel/analytics/next` <Analytics /> with the URL scrubber as beforeSend. Rendered
//      with react-dom/server (layout + wrapper transpiled, leaf imports stubbed).
//   2. CSP: the package's own script loader, driven with production mode and with the
//      dynamic config Vercel injects at build time, picks a SAME-ORIGIN script URL, so the
//      middleware's `script-src 'self'` / `connect-src 'self'` admit it and NO Vercel
//      third-party host is needed (or added) in the production policy.
//   3. Events: trackEvent forwards exactly the closed props; never throws; the scrubber
//      drops query + fragment; every call site in src/ passes literal, non-personal props;
//      only lib/analytics.ts and the wrapper import the package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';
import { withoutComments } from './helpers/code-only.mjs';

const require = createRequire(import.meta.url);
const SRC = join(WEB, 'src');
const read = (rel) => readFileSync(join(WEB, rel), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
const bare = (spec) => new URL(import.meta.resolve(spec)).href;
const withReact = (js) =>
  js
    .replace(/from ['"]react\/jsx-runtime['"]/g, `from '${bare('react/jsx-runtime')}'`)
    .replace(/from ['"]react['"]/g, `from '${bare('react')}'`);

// The real lib/sentry-options.ts (import-free): the same UUID mask Sentry uses.
const SENTRY_OPTIONS = dataUrl(toJs(read('src/lib/sentry-options.ts')));
const libJs = (vercelStub) =>
  toJs(read('src/lib/analytics.ts'))
    .replace(/from ['"]@vercel\/analytics['"]/, `from '${vercelStub}'`)
    .replace(/from ['"]@\/lib\/sentry-options['"]/, `from '${SENTRY_OPTIONS}'`);

/** lib/analytics.ts with `@vercel/analytics` replaced by a recorder (globalThis.__va). */
async function loadAnalyticsLib({ trackThrows = false } = {}) {
  const stub = dataUrl(`
    export function track(name, props) {
      if (${trackThrows}) throw new Error('blocked');
      (globalThis.__va ??= []).push([name, props]);
    }
  `);
  return import(dataUrl(libJs(stub)) + '#' + Math.random());
}

// ── 1. layout mount ─────────────────────────────────────────────────────────

const ANALYTICS_STUB = dataUrl(`
  import { jsx } from '${bare('react/jsx-runtime')}';
  export function Analytics(props) {
    globalThis.__analyticsProps = props;
    return jsx('i', { 'data-testid': 'vercel-analytics' });
  }
`);

async function loadSiteAnalytics() {
  const lib = dataUrl(libJs(dataUrl('export const track = () => {};')));
  const js = withReact(toJs(read('src/components/SiteAnalytics.tsx')))
    .replace(/from ['"]@vercel\/analytics\/next['"]/, `from '${ANALYTICS_STUB}'`)
    .replace(/from ['"]@\/lib\/analytics['"]/, `from '${lib}'`);
  return { mod: await import(dataUrl(js) + '#' + Math.random()), lib: await import(lib) };
}

test('SiteAnalytics imports the Next entry of @vercel/analytics and passes the URL scrubber', async () => {
  const code = withoutComments(read('src/components/SiteAnalytics.tsx'));
  assert.match(code, /^'use client';/, 'must be a client component (beforeSend is a function)');
  assert.match(code, /import \{ Analytics \} from '@vercel\/analytics\/next';/);
  const { mod, lib } = await loadSiteAnalytics();
  const { renderToStaticMarkup } = await import(bare('react-dom/server'));
  const html = renderToStaticMarkup(mod.default());
  assert.match(html, /data-testid="vercel-analytics"/);
  assert.equal(globalThis.__analyticsProps.beforeSend, lib.scrubAnalyticsUrl);
  // No forced mode/debug and no third-party scriptSrc/endpoint override.
  for (const k of ['mode', 'debug', 'scriptSrc', 'endpoint', 'eventEndpoint', 'viewEndpoint', 'dsn']) {
    assert.ok(!(k in globalThis.__analyticsProps), `unexpected prop ${k}`);
  }
});

test('the root layout renders SiteAnalytics inside <body>, after the page', async () => {
  const marker = dataUrl(`
    import { jsx } from '${bare('react/jsx-runtime')}';
    export default function SiteAnalytics() { return jsx('i', { 'data-testid': 'site-analytics' }); }
  `);
  const nothing = dataUrl(`export default function X() { return null; }`);
  const font = dataUrl(`export default function localFont() { return { variable: 'font-jbm' }; }`);
  const site = dataUrl(`export const siteDescription = () => 'd';`);
  const js = withReact(toJs(read('src/app/layout.tsx')))
    .replace(/^import ['"]\.\/globals\.css['"];?$/m, '')
    .replace(/from ['"]next\/font\/local['"]/, `from '${font}'`)
    .replace(/from ['"]@\/components\/FlashBanner['"]/, `from '${nothing}'`)
    .replace(/from ['"]@\/components\/SiteAnalytics['"]/, `from '${marker}'`)
    .replace(/from ['"]@\/lib\/seo\/site['"]/, `from '${site}'`);
  const left = [...js.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((s) => !s.startsWith('data:') && !s.startsWith('file:'));
  assert.deepEqual(left, [], 'an import was left unstubbed');
  const mod = await import(dataUrl(js) + '#' + Math.random());
  const { renderToStaticMarkup } = await import(bare('react-dom/server'));
  const { jsx } = await import(bare('react/jsx-runtime'));
  const html = renderToStaticMarkup(mod.default({ children: jsx('main', { id: 'page' }) }));
  const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  assert.ok(body.includes('data-testid="site-analytics"'), 'SiteAnalytics is not rendered in <body>');
  assert.ok(body.indexOf('id="page"') < body.indexOf('site-analytics'), 'Analytics should follow the page');
  assert.equal(html.match(/site-analytics/g).length, 1, 'mounted exactly once');
});

test('the installed @vercel/analytics supports this Next/React (peer ranges)', () => {
  const pkg = JSON.parse(readFileSync(require.resolve('@vercel/analytics/package.json'), 'utf8'));
  assert.match(pkg.version, /^2\./, 'expected v2 (resilient intake)');
  assert.equal(pkg.peerDependencies.next, '>= 13');
  assert.match(pkg.peerDependencies.react, /\^18/);
});

// ── 2. CSP ──────────────────────────────────────────────────────────────────

/** Drive the package's real inject() with a fake DOM; return the script URL it would load. */
async function scriptSrcFor(props, confString) {
  const mod = await import(bare('@vercel/analytics') + '?' + Math.random());
  let appended = null;
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = {};
  globalThis.document = {
    head: { querySelector: () => null, appendChild: (el) => { appended = el; } },
    createElement: () => ({ dataset: {} }),
  };
  try {
    mod.inject(props, confString);
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  }
  return appended;
}

async function loadCsp() {
  const next = dataUrl(`export const NextResponse = class {}; export const NextRequest = class {};`);
  const ssr = dataUrl(`export const createServerClient = () => ({});`);
  const js = toJs(read('src/middleware.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`)
    .replace(/from ['"]@supabase\/ssr['"]/g, `from '${ssr}'`);
  const csp = (await import(dataUrl(js) + '#' + Math.random())).buildCsp();
  return Object.fromEntries(csp.split('; ').map((d) => { const [n, ...s] = d.split(' '); return [n, s]; }));
}

test('production: the analytics script and its endpoints are same-origin, so script-src/connect-src \'self\' admit them', async () => {
  const site = 'https://stem-loops.com';
  const csp = await loadCsp();
  assert.ok(csp['script-src'].includes("'self'"));
  assert.ok(csp['connect-src'].includes("'self'"));
  const cases = [
    // Default (no Vercel build config): /_vercel/insights/script.js.
    [{ mode: 'production', framework: 'next' }, undefined],
    // v2 "resilient intake": Vercel injects a per-project path at build time.
    [{ mode: 'production', framework: 'next' }, JSON.stringify({ analytics: {
      scriptSrc: '/a1b2c3/script.js', eventEndpoint: '/a1b2c3/event', viewEndpoint: '/a1b2c3/view' } })],
  ];
  for (const [props, conf] of cases) {
    const el = await scriptSrcFor(props, conf);
    assert.ok(el, 'inject() appended no script');
    assert.equal(new URL(el.src, site).origin, site, `script is cross-origin: ${el.src}`);
    for (const k of ['eventEndpoint', 'viewEndpoint', 'endpoint']) {
      if (el.dataset[k]) assert.equal(new URL(el.dataset[k], site).origin, site, `${k} is cross-origin`);
    }
  }
  const def = await scriptSrcFor({ mode: 'production', framework: 'next' });
  assert.equal(def.src, '/_vercel/insights/script.js');
});

test('the production CSP adds no Vercel third-party host (nothing to widen)', async () => {
  const csp = await loadCsp();
  for (const [name, srcs] of Object.entries(csp)) {
    for (const s of srcs) {
      assert.ok(!/vercel-scripts\.com|vercel-insights\.com|vitals\.vercel/.test(s), `${name} has ${s}`);
    }
  }
});

// ── 3. events + no PII ──────────────────────────────────────────────────────

test('trackEvent forwards exactly the closed props; signup sends none', async () => {
  globalThis.__va = [];
  const lib = await loadAnalyticsLib();
  lib.trackEvent('demo_play', { song: 'lucky-ticket' });
  lib.trackEvent('song_added', { source: 'file' });
  lib.trackEvent('song_added', { source: 'link' });
  lib.trackEvent('signup', {});
  assert.deepEqual(globalThis.__va, [
    ['demo_play', { song: 'lucky-ticket' }],
    ['song_added', { source: 'file' }],
    ['song_added', { source: 'link' }],
    ['signup', undefined],
  ]);
});

test('trackEvent never throws (ad blocker / script missing must not break a flow)', async () => {
  const lib = await loadAnalyticsLib({ trackThrows: true });
  assert.doesNotThrow(() => lib.trackEvent('signup', {}));
});

test('beforeSend scrubber drops query string and fragment, keeps the path', async () => {
  const { scrubAnalyticsUrl } = await loadAnalyticsLib();
  const cases = [
    ['https://stem-loops.com/auth/callback?code=secret&next=%2Faccount', 'https://stem-loops.com/auth/callback'],
    ['https://stem-loops.com/success?session_id=cs_live_abc', 'https://stem-loops.com/success'],
    ['https://stem-loops.com/login?return_to=%2Fjobs%2Fx&email=a%40b.c#top', 'https://stem-loops.com/login'],
    ['https://stem-loops.com/demo/lucky-ticket', 'https://stem-loops.com/demo/lucky-ticket'],
    ['/relative/path?x=1', '/relative/path'],
  ];
  for (const [inUrl, out] of cases) {
    const ev = scrubAnalyticsUrl({ type: 'pageview', url: inUrl });
    assert.equal(ev.url, out);
    assert.equal(ev.type, 'pageview');
  }
});

// B-1 (review of #315): a job id is a bearer capability for a job started without an account
// (lib/job-access.ts) and a per-user identifier otherwise. It must never reach Vercel.
test('beforeSend scrubber masks every UUID in the path, any case, page views and events alike', async () => {
  const { scrubAnalyticsUrl } = await loadAnalyticsLib();
  const id = '3f2b9c1e-8a7d-4e2f-9b1c-0d5e6f7a8b9c';
  const ID = id.toUpperCase();
  const cases = [
    [`https://stem-loops.com/jobs/${id}`, 'https://stem-loops.com/jobs/[id]'],
    [`https://stem-loops.com/jobs/${id}/loops`, 'https://stem-loops.com/jobs/[id]/loops'],
    [`https://stem-loops.com/jobs/${ID}?q=1#f`, 'https://stem-loops.com/jobs/[id]'],
    [`https://stem-loops.com/demo/${id}`, 'https://stem-loops.com/demo/[id]'],
    [`https://stem-loops.com/a/${id}/b/${ID}`, 'https://stem-loops.com/a/[id]/b/[id]'],
    [`https://stem-loops.com/loops?job=${id}#${id}`, 'https://stem-loops.com/loops'],
    [`/jobs/${ID}/loops?x=${id}`, '/jobs/[id]/loops'],
    [`not a url /jobs/${id}?x`, 'not a url /jobs/[id]'],
  ];
  for (const type of ['pageview', 'event']) {
    for (const [inUrl, out] of cases) {
      const ev = scrubAnalyticsUrl({ type, url: inUrl });
      assert.equal(ev.url, out, `${type}: ${inUrl}`);
      assert.doesNotMatch(ev.url, /[0-9a-f]{8}-[0-9a-f]{4}-/i, 'a UUID survived');
      assert.equal(ev.type, type);
    }
  }
});

test('navigationGrace is bounded at 150 ms (a larger ask is clamped)', async () => {
  const { navigationGrace, NAV_GRACE_MS } = await loadAnalyticsLib();
  assert.equal(NAV_GRACE_MS, 150);
  const t0 = Date.now();
  await navigationGrace(5000);
  const dt = Date.now() - t0;
  assert.ok(dt >= 140 && dt < 1000, `waited ${dt} ms`);
});

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = walk(SRC).map((p) => [relative(WEB, p), withoutComments(readFileSync(p, 'utf8'))]);

test('only lib/analytics.ts and SiteAnalytics.tsx import @vercel/analytics', () => {
  const importers = files.filter(([, c]) => /from ['"]@vercel\/analytics/.test(c)).map(([f]) => f).sort();
  assert.deepEqual(importers, ['src/components/SiteAnalytics.tsx', 'src/lib/analytics.ts']);
});

test('every trackEvent call site passes literal, non-personal props, at the right moment', () => {
  const calls = files.flatMap(([f, c]) => [...c.matchAll(/\btrackEvent\(([^;]*?)\);/g)].map((m) => [f, m[1]]))
    .filter(([f]) => f !== 'src/lib/analytics.ts');
  const expected = new Map([
    ['src/components/landing/HomeDemo.tsx', [`'demo_play', { song: chosen.slug }`]],
    ['src/components/landing/ToolForm.tsx', [`'song_added', { source: isFile ? 'file' : 'link' }`]],
    ['src/components/LoginForm.tsx', [`'signup', {}`]],
  ]);
  const got = new Map();
  for (const [f, args] of calls) got.set(f, [...(got.get(f) ?? []), args.trim()]);
  assert.deepEqual(Object.fromEntries(got), Object.fromEntries(expected));
  for (const [, args] of calls) {
    assert.doesNotMatch(args, /email|user|jobId|\bid\b|url|file\.name|name|title|password|token/i, `PII-ish prop: ${args}`);
  }
  // Moments: demo_play only once a job id resolved; song_added right after the job is created;
  // signup only after the route said ok.
  const demo = files.find(([f]) => f.endsWith('HomeDemo.tsx'))[1];
  assert.match(demo, /if \(id\) trackEvent\('demo_play'/);
  const tool = files.find(([f]) => f.endsWith('ToolForm.tsx'))[1];
  // The very next statement after addToHistory, same indentation (review S-5), guarded ONLY by
  // `!existing` (#372: a dedupe hit re-opens a live song and is not a new one), so
  // `if (isFile) trackEvent(...)` or a wrapping block fails here.
  assert.match(tool, /\n( +)addToHistory\(jobId\);\n\1if \(!existing\) trackEvent\('song_added', \{ source: isFile \? 'file' : 'link' \}\);\n/);
  // `existing` is set only from the link POST's own `existing === true` (never for uploads).
  assert.deepEqual([...tool.matchAll(/existing = ([^;]+);/g)].map((m) => m[1]), ['false', 'job.existing === true']);
  // ...and the navigation waits the bounded grace first (S-2).
  // A4 round 2: the navigation goes through the form's injectable `deps.assign` (the browser's
  // window.location.assign by default; ToolForm.tsx browserDeps), still straight after the grace.
  assert.match(tool, /\n( +)await navigationGrace\(\);\n(?:[ \t]*\n)*\1deps\.assign\(`\/jobs\/\$\{jobId\}`\);/);
  assert.match(tool, /assign: \(url\) => window\.location\.assign\(url\),/);
  assert.ok(tool.indexOf("postJson<{ id: string; existing?: boolean }>('/api/jobs', { url") > 0);
  assert.ok(tool.indexOf("postJson<{ id: string; existing?: boolean }>('/api/jobs', { url") < tool.indexOf("trackEvent('song_added'"));
  const login = files.find(([f]) => f.endsWith('LoginForm.tsx'))[1];
  assert.ok(login.indexOf('if (!res.ok || !json.ok)') < login.indexOf("trackEvent('signup'"));
});

test('demo_play sends a slug from the public catalog, nothing a user typed', () => {
  const catalog = read('src/lib/demo-catalog.ts');
  assert.match(catalog, /slug/);
  assert.match(withoutComments(read('src/components/landing/HomeDemo.tsx')), /useState<DemoSong>\(DEMO_SONGS\[0\]\)/);
});
