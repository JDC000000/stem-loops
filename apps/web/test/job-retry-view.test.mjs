// Phase B B3 (#321): the failed box on /jobs/[id] — "Try this song again" (data-testid
// "job-retry"), "Upload again", the cap and 429 states, and the "Retry of" link — asserted on
// RENDERED markup of the REAL JobView (the job-page-render.test.mjs idiom: transpile into
// node_modules/.cache, stub the imports, seed useState positionally).
//
// Seeds, in JobView's useState order: [job, missing, trouble, attempt, retryInfo, retryNote,
// retryBusy]. The effect that FETCHES retryInfo is exercised end to end by the browser journey
// j13-retry (real Chromium, real routes); this file covers what each state renders as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'job-retry-view-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

const reactShim = put(
  'react-shim.mjs',
  `let seeds = []; let cursor = 0;
   export function __seed(v) { seeds = v; cursor = 0; }
   export function useState(initial) {
     const i = cursor++;
     const seeded = i < seeds.length && seeds[i] !== undefined;
     return [seeded ? seeds[i] : (typeof initial === 'function' ? initial() : initial), () => {}];
   }
   export function useRef(initial) { return { current: initial }; }
   export function useEffect() {}
   export function useMemo(fn) { return fn(); }
   export function useCallback(fn) { return fn; }`,
);
const el = (name, testid) =>
  put(`${name}.mjs`, `import { createElement } from 'react';
   export function ${name}() { return createElement('div', { 'data-testid': '${testid}' }); }
   export default ${name};`);
const playerMod = el('Player', 'player');
const jobProgressMod = el('JobProgress', 'job-progress');
const linkMod = put('next-link.mjs', `import { createElement } from 'react';
  export default function Link({ href, children, ...rest }) { return createElement('a', { href: String(href), ...rest }, children); }`);
const retentionMod = put('retention.mjs', `export const formatExpiresIn = () => 'in 24 hours'; export const isDemoRow = (j) => j?.is_demo === true;`);
const jobPollMod = put('job-poll.mjs', toJs(read('src/lib/job-poll.ts')));
const errorCopyMod = put('error-copy.mjs', toJs(read('src/lib/error-copy.ts')));
const inputTrimMod = put('input-trim.mjs', toJs(read('src/lib/input-trim.ts')));
const jobLabelMod = put('job-label.mjs', toJs(read('src/lib/job-label.ts')));
const processingHeadingMod = put(
  'ProcessingHeading.mjs',
  toJs(read('src/components/ProcessingHeading.tsx')).replace(/from ['"]@\/lib\/job-label['"]/g, `from '${jobLabelMod}'`),
);
const demoCatalogMod = put('demo-catalog.mjs', toJs(read('src/lib/demo-catalog.ts')));
const js = toJs(read('src/app/jobs/[id]/JobView.tsx'))
  .replace(/from ['"]react['"]/g, `from '${reactShim}'`)
  .replace(/from ['"]@\/components\/play\/Player['"]/g, `from '${playerMod}'`)
  .replace(/from ['"]@\/components\/JobProgress['"]/g, `from '${jobProgressMod}'`)
  .replace(/from ['"]next\/link['"]/g, `from '${linkMod}'`)
  .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retentionMod}'`)
  .replace(/from ['"]@\/lib\/job-poll['"]/g, `from '${jobPollMod}'`)
  .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${errorCopyMod}'`)
  .replace(/from ['"]@\/lib\/input-trim['"]/g, `from '${inputTrimMod}'`)
  .replace(/from ['"]@\/lib\/job-label['"]/g, `from '${jobLabelMod}'`)
  .replace(/from ['"]@\/components\/ProcessingHeading['"]/g, `from '${processingHeadingMod}'`)
  .replace(/from ['"]@\/lib\/demo-catalog['"]/g, `from '${demoCatalogMod}'`);
writeFileSync(join(dir, 'JobView.mjs'), js);
const unresolved = [...js.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((s) => !s.startsWith('.') && s !== 'react/jsx-runtime');

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const shim = await import(pathToFileURL(join(dir, 'react-shim.mjs')).href);
const JobView = (await import(pathToFileURL(join(dir, 'JobView.mjs')).href)).default;
const copy = await import(pathToFileURL(join(dir, 'error-copy.mjs')).href);

const ORIG = '11111111-1111-4111-8111-111111111111';
const LINK_FAILED = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222',
  status: 'failed',
  input_kind: 'youtube',
  youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  original_filename: null,
  title: 'A song',
  error_code: 'FETCH_PROXY_FAILED',
  error_message_user: 'Something went wrong on our end fetching this video. Try again later.',
  expires_at: null,
  loops: [],
  events: [],
});
const UPLOAD_FAILED = Object.freeze({ ...LINK_FAILED, input_kind: 'upload', youtube_url: null, original_filename: 'take.mp3', error_code: 'SEPARATION_FAILED' });

function render(job, retryInfo, retryNote, retryBusy) {
  shim.__seed([job, false, undefined, undefined, retryInfo, retryNote, retryBusy]);
  return renderToStaticMarkup(React.createElement(JobView, { id: job.id }));
}
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const button = (html) => html.match(/<button[^>]*data-testid="job-retry"[^>]*>([^<]*)<\/button>/);
const primaryCount = (html) => (html.match(/class="jp-primary"/g) ?? []).length;

test('harness: every JobView import is stubbed, and a seeded failed job reaches the failed box', () => {
  assert.deepEqual(unresolved, []);
  const html = render(LINK_FAILED, null);
  assert.match(html, /Something went wrong/);
  assert.doesNotMatch(html, /Loading…/);
});

test('AC1: an eligible failed link job shows "Try this song again" (job-retry), ≥ 44 px, one primary fill', () => {
  const html = render(LINK_FAILED, { action: 'eligible', retries_left: 2, charge: 'free', retry_of: null });
  const b = button(html);
  assert.ok(b, 'no job-retry button rendered');
  assert.equal(decode(b[1]), copy.RETRY_BUTTON_LABEL);
  assert.notEqual(copy.RETRY_BUTTON_LABEL, 'Try again');
  assert.match(b[0], /min-height:48px/);
  assert.match(b[0], /class="jp-primary"/);
  assert.equal(primaryCount(html), 1, 'the retry is the one primary fill; Start a new song steps down');
  assert.match(decode(html), new RegExp(copy.RETRY_COST_FREE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /href="\/"[^>]*>Start a new song</);
});

test('a charged retry says it uses 1 of your songs before the tap', () => {
  const html = decode(render(LINK_FAILED, { action: 'eligible', retries_left: 1, charge: 'charged' }));
  assert.ok(html.includes(copy.RETRY_COST_CHARGED));
  assert.ok(!html.includes(copy.RETRY_COST_FREE));
});

test('AC1: not eligible (none), not yet known (null) → no button; Start a new song is the primary', () => {
  for (const info of [null, { action: 'none' }]) {
    const html = render(LINK_FAILED, info);
    assert.equal(button(html), null, JSON.stringify(info));
    assert.match(html, /class="jp-primary"[^>]*>Start a new song</);
  }
});

test('AC1: a failed upload shows "Upload again" and never a retry button', () => {
  for (const info of [null, { action: 'eligible', retries_left: 2, charge: 'free' }]) {
    const html = render(UPLOAD_FAILED, info);
    assert.equal(button(html), null);
    assert.match(html, /data-testid="job-upload-again"[^>]*>Upload again</);
    assert.match(html, /href="\/"[^>]*data-testid="job-upload-again"|data-testid="job-upload-again"[^>]*href="\/"|<a href="\/" class="jp-primary" data-testid="job-upload-again"/);
  }
});

test('AC2: after 2 retries (cap) → no button, the limit sentence', () => {
  const html = decode(render(LINK_FAILED, { action: 'cap_reached', retry_of: ORIG }));
  assert.equal(button(html), null);
  assert.match(html, /data-testid="job-retry-limit"/);
  assert.ok(html.includes(copy.RETRY_LIMIT_MSG));
});

test('AC6 / C-1: a 429 retry keeps the button and says why', () => {
  const html = decode(render(LINK_FAILED, { action: 'eligible', retries_left: 2, charge: 'free' }, "You're sending requests too fast. Wait a minute and try again."));
  assert.ok(button(html), 'the button must still be offered after a 429');
  assert.match(html, /role="status" data-testid="job-retry-note"[^>]*>You're sending requests too fast/);
});

test('busy: the button is disabled while the retry is being started (no double POST from one page)', () => {
  const html = render(LINK_FAILED, { action: 'eligible', retries_left: 2, charge: 'free' }, null, true);
  assert.match(button(html)[0], /disabled=""/);
});

test('already retried (another tab) → no button, a link to the new try', () => {
  const html = decode(render(LINK_FAILED, { action: 'already_retried', retried_by: ORIG }));
  assert.equal(button(html), null);
  assert.match(html, new RegExp(`data-testid="job-retry-already"[^>]*>${copy.RETRY_ALREADY_MSG} <a href="/jobs/${ORIG}">${copy.RETRY_GO_TO_LABEL}</a>`));
});

test('AC7: a retry\'s page links "Retry of" its original — failed and processing', () => {
  const failed = decode(render(LINK_FAILED, { action: 'eligible', retries_left: 1, charge: 'free', retry_of: ORIG }));
  assert.match(failed, new RegExp(`data-testid="job-retry-of"[^>]*>Retry of <a href="/jobs/${ORIG}"[^>]*>your earlier try</a>`));
  const processing = decode(render({ ...LINK_FAILED, status: 'queued', error_code: null }, { action: 'none', retry_of: ORIG }));
  assert.match(processing, new RegExp(`data-testid="job-retry-of"[^>]*>Retry of <a href="/jobs/${ORIG}"`));
  // An original (retry_of null) has no such line.
  assert.doesNotMatch(render(LINK_FAILED, { action: 'eligible', retries_left: 2, charge: 'free', retry_of: null }), /job-retry-of/);
});

test('the poll panel\'s "Try again" is untouched and distinct from the retry button', () => {
  const html = render({ ...LINK_FAILED, status: 'queued' }, null);
  void html;
  const src = read('src/app/jobs/[id]/JobView.tsx');
  assert.match(src, />\s*Try again\s*</, 'the unreachable panel keeps its Try again');
  assert.match(src, /data-testid="job-retry"/);
});

test('review R1: the "Retry of" link is a ≥ 24 px tap target', () => {
  const html = render(LINK_FAILED, { action: 'none', retry_of: ORIG });
  const a = html.match(/<a[^>]*data-testid="job-retry-of-link"[^>]*>/)?.[0];
  assert.ok(a, 'no Retry of link');
  assert.match(a, /display:inline-block/);
  assert.match(a, /min-height:24px/);
});

test('review R1: a used-up trial (GET trial_used) → no button, the retry-specific line (no credit pack)', () => {
  const html = decode(render(LINK_FAILED, { action: 'trial_used', message: copy.RETRY_TRIAL_USED_MSG }));
  assert.equal(button(html), null);
  assert.ok(html.includes(copy.RETRY_TRIAL_USED_MSG));
  assert.doesNotMatch(copy.RETRY_TRIAL_USED_MSG, /credit/i);
});
