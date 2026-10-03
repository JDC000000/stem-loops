// Security review 2026-10-03. Dependency-free guard (node:test + the existing `typescript` devDependency).
// Imports every Sentry config with a mocked SDK and fails if tracing can be on without beforeSendTransaction,
// if the sampler is not 0 for a sampled parent, if a transaction keeps cookies/IPs/job ids, or if a new
// Sentry.init site appears outside the guarded files.
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
