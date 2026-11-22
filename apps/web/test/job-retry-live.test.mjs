// Phase B B3 (#321): the failed box's retry EFFECTS, mounted with real React in happy-dom
// (helpers/dom.mjs) and a stubbed fetch: GET /api/jobs/:id/retry is asked for a signed-in link
// job, a RATE_LIMITED cooldown asks again when it ends (review R1 should-fix 4), and a 429 from
// POST keeps the button (C-1). The rendered states themselves are in job-retry-view.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'job-retry-live-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};
const el = (name, testid) =>
  put(`${name}.mjs`, `import { createElement } from 'react';
   export function ${name}() { return createElement('div', { 'data-testid': '${testid}' }); }
   export default ${name};`);
const js = toJs(read('src/app/jobs/[id]/JobView.tsx'))
  .replace(/from ['"]@\/components\/play\/Player['"]/g, `from '${el('Player', 'player')}'`)
  .replace(/from ['"]@\/components\/JobProgress['"]/g, `from '${el('JobProgress', 'job-progress')}'`)
  .replace(/from ['"]next\/link['"]/g, `from '${put('next-link.mjs', `import { createElement } from 'react';
    export default function Link({ href, children, ...rest }) { return createElement('a', { href: String(href), ...rest }, children); }`)}'`)
  .replace(/from ['"]@\/lib\/retention['"]/g, `from '${put('retention.mjs', `export const formatExpiresIn = () => 'x'; export const isDemoRow = () => false;`)}'`)
  .replace(/from ['"]@\/lib\/job-poll['"]/g, `from '${put('job-poll.mjs', toJs(read('src/lib/job-poll.ts')))}'`)
  .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${put('error-copy.mjs', toJs(read('src/lib/error-copy.ts')))}'`)
  .replace(/from ['"]@\/lib\/input-trim['"]/g, `from '${put('input-trim.mjs', toJs(read('src/lib/input-trim.ts')))}'`)
  .replace(/from ['"]@\/lib\/job-label['"]/g, `from '${put('job-label.mjs', toJs(read('src/lib/job-label.ts')))}'`)
  .replace(/from ['"]@\/components\/ProcessingHeading['"]/g, `from '${el('ProcessingHeading', 'heading')}'`)
  .replace(/from ['"]@\/lib\/demo-catalog['"]/g, `from '${put('demo-catalog.mjs', toJs(read('src/lib/demo-catalog.ts')))}'`);
writeFileSync(join(dir, 'JobView.mjs'), js);

const React = (await import('react')).default;
const JobView = (await import(pathToFileURL(join(dir, 'JobView.mjs')).href)).default;

const ID = '22222222-2222-4222-8222-222222222222';
const JOB = {
  id: ID, status: 'failed', input_kind: 'youtube', youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  original_filename: null, error_code: 'FETCH_PROXY_FAILED', error_message_user: 'Something went wrong on our end.',
  updated_at: new Date().toISOString(), events: [], loops: [], expires_at: null,
};
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => new Date().toUTCString() }, json: async () => body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Installed once, outside withDom (whose teardown refuses a changed globalThis.fetch).
let current = { serve: () => res(500, {}), calls: [] };
globalThis.fetch = async (url, init = {}) => {
  current.calls.push(`${init.method ?? 'GET'} ${url}`);
  return current.serve(String(url), init.method ?? 'GET');
};

async function mount(dom, serve) {
  const calls = [];
  current = { serve, calls };
  await dom.mount(React.createElement(JobView, { id: ID }));
  return calls;
}
async function waitFor(dom, sel, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (dom.find(sel)) return dom.find(sel);
    await dom.act(() => sleep(50));
  }
  return null;
}

test('a cooldown answer re-checks when the cooldown ends, and the button then appears', async () => {
  await withDom(async (dom) => {
    let retryGets = 0;
    const calls = await mount(dom, (url) => {
      if (url.endsWith('/retry')) {
        retryGets += 1;
        return res(200, retryGets === 1 ? { action: 'cooldown', retry_after_s: 1, retry_of: null } : { action: 'eligible', retries_left: 2, charge: 'free', retry_of: null });
      }
      return res(200, JOB);
    });
    assert.ok(await waitFor(dom, '[data-testid="job-retry-cooldown"]'), 'the cooldown state is shown first');
    assert.equal(dom.find('[data-testid="job-retry"]'), null);
    assert.ok(await waitFor(dom, '[data-testid="job-retry"]', 5000), 'after the cooldown the box asked again and offers the retry');
    assert.equal(calls.filter((c) => c.endsWith('/retry')).length, 2);
  });
});

test('C-1: a 429 from POST shows the reason and keeps the button', async () => {
  await withDom(async (dom) => {
    await mount(dom, (url, method) => {
      if (url.endsWith('/retry') && method === 'POST') return res(429, { error_code: 'RATE_LIMITED', message: 'Slow down please.' });
      if (url.endsWith('/retry')) return res(200, { action: 'eligible', retries_left: 2, charge: 'free', retry_of: null });
      return res(200, JOB);
    });
    const b = await waitFor(dom, '[data-testid="job-retry"]');
    assert.ok(b);
    await dom.act(async () => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const note = await waitFor(dom, '[data-testid="job-retry-note"]');
    assert.equal(note?.textContent, 'Slow down please.');
    assert.ok(dom.find('[data-testid="job-retry"]'), 'the button is still offered');
  });
});

test('a 429 RETRY_LIMIT hides the button and says the limit', async () => {
  await withDom(async (dom) => {
    await mount(dom, (url, method) => {
      if (url.endsWith('/retry') && method === 'POST') return res(429, { error_code: 'RETRY_LIMIT', message: 'limit' });
      if (url.endsWith('/retry')) return res(200, { action: 'eligible', retries_left: 1, charge: 'free', retry_of: null });
      return res(200, JOB);
    });
    const b = await waitFor(dom, '[data-testid="job-retry"]');
    await dom.act(async () => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.ok(await waitFor(dom, '[data-testid="job-retry-limit"]'));
    assert.equal(dom.find('[data-testid="job-retry"]'), null);
  });
});
