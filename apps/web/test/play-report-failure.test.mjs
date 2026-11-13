// reportStemFetchFailure — the browser-side report for a stem GET that never got a
// response (the shape of a missing R2 CORS rule). Sentry is mocked exactly as
// test/sentry-guard.test.mjs mocks it: no network, no new dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const SRC = readFileSync(join(WEB, 'src/lib/play/report-failure.ts'), 'utf8');

/** Fresh module instance (its once-per-page flag is module state) with a mock Sentry. */
async function fresh() {
  const calls = [];
  const logs = [];
  globalThis.__sentryMock = {
    captureMessage: (msg, ctx) => calls.push({ msg, ctx }),
  };
  const js = toJs(SRC).replace(/import \* as Sentry from ['"]@sentry\/nextjs['"];?/, 'const Sentry = globalThis.__sentryMock;');
  const realError = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  const mod = await import(dataUrl(js) + '#' + Math.random());
  return { mod, calls, logs, restore: () => (console.error = realError) };
}

const SUMMARY = {
  listed: 6,
  network: 6,
  http: 0,
  httpStatuses: [],
  body: 0,
  storageOrigins: ['https://acct.r2.cloudflarestorage.com'],
};

test('reports a FETCH_NETWORK failure once, under a fixed fingerprint, with counts and origins only', async () => {
  const { mod, calls, logs, restore } = await fresh();
  try {
    mod.reportStemFetchFailure('FETCH_NETWORK', SUMMARY);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].ctx.fingerprint, ['play-along', 'STEM_FETCH', 'FETCH_NETWORK']);
    assert.equal(calls[0].ctx.level, 'error');
    assert.equal(calls[0].ctx.extra.listed, 6);
    assert.equal(calls[0].ctx.extra.network, 6);
    assert.deepEqual(calls[0].ctx.extra.storageOrigins, ['https://acct.r2.cloudflarestorage.com']);
    assert.equal(logs.length, 1, 'the console line exists whether or not a DSN is configured');
    assert.match(logs[0], /FETCH_NETWORK/);
  } finally {
    restore();
  }
});

test('nothing sent or logged can carry a presigned signature, a path, a query or a job id', async () => {
  const { mod, calls, logs, restore } = await fresh();
  try {
    mod.reportStemFetchFailure('FETCH_HTTP', { ...SUMMARY, network: 0, http: 6, httpStatuses: [403] });
    const wire = JSON.stringify(calls) + logs.join('\n');
    for (const leak of ['X-Amz', 'Signature', '.opus', '?', '11111111-2222-3333-4444-555555555555']) {
      assert.ok(!wire.includes(leak), `report leaked ${leak}`);
    }
    // the origin the owner needs for the CORS comparison is present
    assert.match(wire, /r2\.cloudflarestorage\.com/);
  } finally {
    restore();
  }
});

test('at most one event per page load, even across reasons', async () => {
  const { mod, calls, restore } = await fresh();
  try {
    mod.reportStemFetchFailure('FETCH_NETWORK', SUMMARY);
    mod.reportStemFetchFailure('FETCH_NETWORK', SUMMARY);
    mod.reportStemFetchFailure('FETCH_HTTP', SUMMARY);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('a throwing Sentry never breaks the page', async () => {
  const { mod, restore } = await fresh();
  try {
    globalThis.__sentryMock.captureMessage = () => {
      throw new Error('sdk blew up');
    };
    assert.doesNotThrow(() => mod.reportStemFetchFailure('FETCH_NETWORK', SUMMARY));
  } finally {
    restore();
  }
});

test('encode_failed is not a reportable reason from the browser (the worker reports it once per job)', () => {
  assert.doesNotMatch(SRC.replace(/\/\*[\s\S]*?\*\//g, ''), /ENCODE/);
});
