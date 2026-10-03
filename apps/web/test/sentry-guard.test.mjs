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
