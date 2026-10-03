// Security review 2026-10-03. Dependency-free guard (node:test + the existing `typescript` devDependency).
// Imports every Sentry config with a mocked SDK and fails if tracing can be on without beforeSendTransaction,
// if the sampler is not 0 for a sampled parent, if a transaction keeps cookies/IPs/job ids, or if a new
// Sentry.init site appears outside the guarded files. Breadcrumbs ride along on every error event, so each
// config must also scrub them (signed R2 URLs, presigned PUTs, job ids in fetch/xhr/navigation/console crumbs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGS = ['instrumentation-client.ts', 'sentry.edge.config.ts', 'sentry.server.config.ts'];
const JOB = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b';

const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const optionsUrl = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/sentry-options.ts'), 'utf8')));

async function initOptions(file) {
  let js = toJs(readFileSync(join(WEB, file), 'utf8'));
  js = js
    .replace(/import \* as Sentry from ['"]@sentry\/nextjs['"];?/, 'const Sentry = globalThis.__sentryMock;')
    .replace(/from ['"]\.\/src\/lib\/sentry-options['"]/, `from '${optionsUrl}'`);
  const calls = [];
  globalThis.__sentryMock = { init: (o) => calls.push(o), captureRequestError: () => {} };
  process.env.SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
  await import(dataUrl(js) + '#' + Math.random());
  assert.equal(calls.length, 1, `${file} did not call Sentry.init once`);
  return calls[0];
}

test('every Sentry.init site is a guarded config', () => {
  const walk = (d) =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (n === 'node_modules' || n === '.next') return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(p) ? [p] : [];
    });
  const sites = walk(WEB)
    .filter((f) => !f.includes(`${'/'}test${'/'}`) && /Sentry\.init\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB, f))
    .sort();
  assert.deepEqual(sites, [...CONFIGS].sort());
});

for (const file of CONFIGS) {
  test(`${file}: tracing off and transactions scrubbed`, async () => {
    const o = await initOptions(file);
    if (typeof o.tracesSampleRate === 'number' && o.tracesSampleRate > 0) {
      assert.equal(typeof o.beforeSendTransaction, 'function', 'tracesSampleRate > 0 needs beforeSendTransaction');
    }
    assert.equal(typeof o.tracesSampler, 'function', 'use tracesSampler returning 0, not only a rate');
    assert.equal(o.tracesSampler({ parentSampled: true, name: 'GET /' }), 0);
    assert.equal(typeof o.beforeSendTransaction, 'function');
    assert.equal(typeof o.beforeSend, 'function');
    assert.notEqual(o.sendDefaultPii, true);

    const tx = o.beforeSendTransaction({
      type: 'transaction',
      transaction: `/jobs/${JOB}`,
      request: {
        url: `https://stem-loops.com/api/jobs/${JOB}?x=1`,
        query_string: 'x=1',
        cookies: { 'sl-history': 'b64.sig' },
        headers: { cookie: 'sl-history=b64.sig', 'x-forwarded-for': '1.2.3.4', 'user-agent': 'UA' },
      },
      user: { ip_address: '1.2.3.4' },
    });
    const s = JSON.stringify(tx);
    for (const bad of ['b64.sig', '1.2.3.4', JOB, 'x=1']) assert.ok(!s.includes(bad), `transaction kept ${bad}`);
    assert.equal(tx.request.headers['user-agent'], 'UA');

    const span = o.beforeSendSpan({
      description: `GET /api/jobs/${JOB}`,
      data: { 'url.full': `https://stem-loops.com/jobs/${JOB}`, 'client.address': '1.2.3.4', 'http.request.header.cookie': 'x', 'http.method': 'GET' },
    });
    assert.deepEqual(span.data, { 'url.full': 'https://stem-loops.com/jobs/[id]', 'http.method': 'GET' });
    assert.equal(span.description, 'GET /api/jobs/[id]');
  });
}

const R2 = 'https://acct.r2.cloudflarestorage.com/stem-loops';
const SIG = 'X-Amz-Signature=deadbeefsig';
const signed = (key) => `${R2}/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261003&${SIG}`;

for (const file of CONFIGS) {
  test(`${file}: breadcrumbs scrubbed`, async () => {
    const o = await initOptions(file);
    assert.equal(typeof o.beforeBreadcrumb, 'function', 'breadcrumbs carry signed URLs and job ids');
    const crumb = (c) => {
      const out = o.beforeBreadcrumb(structuredClone(c), {});
      for (const bad of [JOB, 'deadbeefsig', 'AKIAEXAMPLE', 'X-Amz-', 'secret=1', 'p4ss'])
        assert.ok(!JSON.stringify(out).includes(bad), `${c.category} breadcrumb kept ${bad}`);
      return out;
    };

    // Signed R2 GET (useAudition / zipLoops): query and key gone, method/status kept.
    const get = crumb({ category: 'fetch', type: 'http', data: { method: 'GET', url: signed(`${JOB}/loop_1.wav`), status_code: 200 } });
    assert.deepEqual(get.data, { method: 'GET', url: 'https://acct.r2.cloudflarestorage.com/[presigned]', status_code: 200 });

    // Presigned PUT upload (page.tsx XHR): only origin, method and status survive.
    const put = crumb({
      category: 'xhr',
      type: 'http',
      data: { method: 'PUT', url: signed(`${JOB}/_input.mp3`), status_code: 200, request_body_size: 5, response_body_size: 0 },
    });
    assert.deepEqual(put.data, { method: 'PUT', url: 'https://acct.r2.cloudflarestorage.com/[presigned]', status_code: 200 });

    // App API fetch: job id masked, query stripped, the rest kept.
    const api = crumb({ category: 'fetch', type: 'http', data: { method: 'GET', url: `/api/jobs/${JOB}?secret=1`, status_code: 404 } });
    assert.deepEqual(api.data, { method: 'GET', url: '/api/jobs/[id]', status_code: 404 });

    // Node http breadcrumb keeps the query in its own key.
    const node = crumb({ category: 'http', data: { url: `https://p:p4ss@x.example/jobs/${JOB}`, 'http.method': 'GET', 'http.query': 'secret=1' } });
    assert.deepEqual(node.data, { url: 'https://[redacted]@x.example/jobs/[id]', 'http.method': 'GET' });
    const nodePut = crumb({
      category: 'http',
      data: { url: `${R2}/${JOB}/_input.mp3`, 'http.method': 'PUT', 'http.query': `?X-Amz-Credential=AKIAEXAMPLE&${SIG}`, status_code: 200 },
    });
    assert.deepEqual(nodePut.data, { url: 'https://acct.r2.cloudflarestorage.com/[presigned]', 'http.method': 'PUT', status_code: 200 });

    // Navigation.
    const nav = crumb({ category: 'navigation', data: { from: `/jobs/${JOB}?secret=1`, to: `/jobs/${JOB}#x` } });
    assert.deepEqual(nav.data, { from: '/jobs/[id]', to: '/jobs/[id]' });

    // Console: message scrubbed, raw arguments dropped.
    const con = crumb({
      category: 'console',
      level: 'error',
      message: `audition failed ${signed(`${JOB}/loop_2.wav`)} for job ${JOB}`,
      data: { arguments: ['audition failed', signed(`${JOB}/loop_2.wav`)], logger: 'console' },
    });
    assert.equal(con.message, 'audition failed https://acct.r2.cloudflarestorage.com/[presigned] for job [id]');
    assert.deepEqual(con.data, { logger: 'console' });

    // Harmless crumbs pass through unchanged.
    const ui = { category: 'ui.click', message: 'button.upload' };
    assert.deepEqual(o.beforeBreadcrumb(structuredClone(ui), {}), ui);
  });
}

test('scrubText strips queries from absolute AND relative URLs', async () => {
  const { scrubText } = await import(optionsUrl);
  assert.equal(
    scrubText(`GET /stem-loops/${JOB}/x.wav?X-Amz-Credential=AKIAEXAMPLE&${SIG} -> 403`),
    'GET /[presigned] -> 403',
  );
  assert.equal(scrubText(`see /api/jobs/${JOB}?secret=1#frag and /jobs/${JOB}`), 'see /api/jobs/[id] and /jobs/[id]');
  assert.equal(scrubText(`url=${R2}/${JOB}/a.wav?${SIG}`), 'url=https://acct.r2.cloudflarestorage.com/[presigned]');
  // A bare signature parameter outside any recognisable URL is still redacted.
  assert.equal(scrubText(`key=k&${SIG}&x=1`), 'key=k&X-Amz-Signature=[redacted]&x=1');
  // Plain text and query-less relative paths are untouched (apart from job ids).
  assert.equal(scrubText('a/b c 12:30 /api/health'), 'a/b c 12:30 /api/health');
});

// Server errors reach Sentry through `onRequestError = Sentry.captureRequestError` (instrumentation.ts).
// That path puts the raw path + query in contexts.nextjs.request_path and copies every request header
// (referer, next-url, x-invoke-path, x-vercel-ip-*) onto the event. Drive the real SDK with each server-side
// config's options and a capturing transport.
test('instrumentation.ts reports server errors via captureRequestError', () => {
  assert.match(readFileSync(join(WEB, 'instrumentation.ts'), 'utf8'), /onRequestError\s*=\s*Sentry\.captureRequestError/);
});

// The real SDK can be initialised only once per process, so it is initialised with the first config's
// options and the event/breadcrumb hooks delegate to whichever config is under test.
let realSdk;
let hooks;
const events = [];
function realSentry(o) {
  if (!realSdk) {
    // The CJS build: the ESM namespace misses the SDK's re-exported functions (flush, ...).
    realSdk = createRequire(import.meta.url)('@sentry/nextjs');
    const transport = () => ({
      send: async ([, items]) => {
        for (const [h, payload] of items) if (h.type === 'event') events.push(payload);
        return { statusCode: 200 };
      },
      flush: async () => true,
    });
    // Default integrations, as in prod (RequestData builds event.request).
    realSdk.init({
      ...o,
      transport,
      beforeSend: (e, h) => hooks.beforeSend(e, h),
      beforeBreadcrumb: (b, h) => hooks.beforeBreadcrumb(b, h),
    });
  }
  hooks = o;
  events.length = 0;
  return realSdk;
}

for (const file of ['sentry.server.config.ts', 'sentry.edge.config.ts']) {
  test(`${file}: real captureRequestError event is scrubbed`, async () => {
    const o = await initOptions(file);
    const Sentry = realSentry(o);
    Sentry.captureRequestError(
      new Error('boom'),
      {
        path: `/api/jobs/${JOB}?t=SECRETQ`,
        method: 'GET',
        headers: {
          cookie: 'sl-history=b64.SIG',
          referer: `https://stem-loops.com/jobs/${JOB}?ref=SECRETQ`,
          'next-url': `/jobs/${JOB}`,
          'x-invoke-path': `/api/jobs/${JOB}`,
          'x-invoke-query': '%7B%22t%22%3A%22SECRETQ%22%7D',
          'x-forwarded-for': '9.9.9.9',
          'x-real-ip': '9.9.9.9',
          'x-vercel-ip-city': 'Seattle',
          'x-vercel-ip-latitude': '47.6062',
          'x-vercel-ip-longitude': '-122.3321',
          'x-vercel-ip-country': 'US',
          'x-vercel-oidc-token': 'OIDCSECRET',
          'x-matched-path': '/api/jobs/[id]',
          'user-agent': 'UA',
        },
      },
      { routerKind: 'App Router', routePath: '/api/jobs/[id]', routeType: 'route' },
    );
    await Sentry.flush(2000);
    assert.equal(events.length, 1, 'captureRequestError produced no error event');
    const ev = events[0];
    for (const v of ev.exception?.values ?? []) delete v.stacktrace; // frames quote this test's own source
    const s = JSON.stringify(ev);
    for (const bad of [JOB, 'SECRETQ', 'b64.SIG', '9.9.9.9', 'Seattle', '47.6062', '-122.3321', 'OIDCSECRET'])
      assert.ok(!s.includes(bad), `captureRequestError event kept ${bad}`);
    assert.ok(!Object.keys(ev.request.headers).some((k) => /^x-vercel-ip-/i.test(k)), 'geo headers kept');
    assert.equal(ev.contexts.nextjs.request_path, '/api/jobs/[id]');
    assert.equal(ev.request.headers.referer, 'https://stem-loops.com/jobs/[id]');
    assert.equal(ev.request.headers['x-matched-path'], '/api/jobs/[id]');
    assert.equal(ev.request.headers['user-agent'], 'UA');
    assert.equal(ev.exception.values[0].value, 'boom');
  });
}
