/**
 * /loops (Story 6) — the real LoopsView, mounted in happy-dom and CLICKED.
 *
 * What is real: LoopsView itself, lib/loops/availability.ts and lib/retention.ts
 * (the 24-hour window and its copy). What is replaced, at the import seam:
 *   - <LoopResults>, by a recorder. It has its own mounted suite
 *     (test/loops-results-on-demand.test.mjs), including the disabled-after-24h
 *     gates; here the question is only whether THIS page mounts it, for which
 *     job, and with which `closed` reason.
 *   - lib/history, by a stub. The page's real reads go through `deps.listSongs`
 *     anyway; the stub only stops the module's `@/` import from failing to load.
 * Every outside-world call (job fetch, stems state, address bar, clock) goes
 * through `deps` and is COUNTED, so "nothing is fetched until a song is picked"
 * and "an old song is closed without a request" are read off counters, before
 * and after, not inferred.
 *
 * What this harness cannot see: layout and paint (helpers/dom.mjs header). The
 * phone-width screenshots in docs/design/screens-2026-11-14/loops/ are the
 * geometry evidence, and nothing here gates them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { withDom, setNativeValue } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
// The LoopResults recorder writes here. Created at module scope, OUTSIDE any
// withDom(), so the harness's global-pollution check does not see it appear.
globalThis.__loopResultsMounts = [];
const real = (p) => pathToFileURL(join(WEB, p)).href;

async function loadLoopsView() {
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const outDir = mkdtempSync(join(cache, 'loops-view-'));
  const stub = (name, src) => {
    const f = join(outDir, `${name}.mjs`);
    writeFileSync(f, src);
    return pathToFileURL(f).href;
  };
  const resultsUrl = stub(
    'loop-results',
    `import { jsx } from 'react/jsx-runtime';
     export function LoopResults(props) {
       globalThis.__loopResultsMounts.push(props);
       return jsx('div', {
         'data-testid': 'loop-results',
         'data-job': props.job.id,
         'data-closed': String(props.closed ?? ''),
       });
     }`,
  );
  const historyUrl = stub('history', `export const getStoredHistoryEntries = () => [];`);

  const js = ts
    .transpileModule(readFileSync(join(WEB, 'src/app/loops/LoopsView.tsx'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    })
    .outputText.replace(/from ['"]@\/components\/LoopResults['"]/g, `from '${resultsUrl}'`)
    .replace(/from ['"]@\/lib\/history['"]/g, `from '${historyUrl}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${real('src/lib/retention.ts')}'`)
    .replace(/from ['"]@\/lib\/loops\/availability['"]/g, `from '${real('src/lib/loops/availability.ts')}'`);
  // Guard: an import this loader does not know about would fail to resolve and
  // the suite would die before saying why. Name it instead.
  const unknown = [...js.matchAll(/from ['"](@\/[^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(unknown, [], `LoopsView imports ${unknown.join(', ')}, which this loader does not map`);
  const out = join(outDir, 'LoopsView.mjs');
  writeFileSync(out, js);
  return (await import(pathToFileURL(out).href)).default;
}

// ── fixtures: literal times, never recomputed with the module's helpers ────
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const FRESH = 'aaaaaaaa-1111-4111-8111-111111111111'; // started 2h ago
const OLD = 'bbbbbbbb-2222-4222-8222-222222222222'; // started 30h ago
const STRANGER = 'cccccccc-3333-4333-8333-333333333333'; // not in this browser's list

const loopRow = (id, cut) => ({ id, stem: 'drums', start_sec: 0, end_sec: 8, cut_at: cut ? 'x' : null });
const doneJob = (id, loops) => ({
  id,
  status: 'done',
  bpm: 120,
  musical_key: 'C major',
  original_filename: 'a-song.mp3',
  expires_at: '2026-11-15T10:00:00.000Z',
  loops,
});

function harness({ songs = [], jobs = {}, stems = 'ready' } = {}) {
  const calls = { fetchJob: [], fetchStemsState: [], setUrl: [] };
  const deps = {
    listSongs: () => songs,
    fetchJob: async (id) => {
      calls.fetchJob.push(id);
      return jobs[id] ?? { kind: 'not_found' };
    },
    fetchStemsState: async (id) => {
      calls.fetchStemsState.push(id);
      return stems;
    },
    setUrl: (id) => calls.setUrl.push(id),
    now: () => NOW,
  };
  return { calls, deps };
}

const SONGS = [
  { id: FRESH, at: NOW - 2 * HOUR },
  { id: OLD, at: NOW - 30 * HOUR },
];

async function settle(dom) {
  // fetchJob -> fetchStemsState -> setView: a few microtask turns.
  for (let i = 0; i < 5; i += 1) await dom.act(async () => {});
}

test('no songs on this browser: an empty state with a way to start one, and no request', async () => {
  const LoopsView = await loadLoopsView();
  const { calls, deps } = harness();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await settle(dom);
    const empty = dom.find('[data-testid="lp-no-songs"]');
    assert.ok(empty, 'no empty state');
    assert.equal(empty.querySelector('a')?.getAttribute('href'), '/');
    assert.deepEqual(calls.fetchJob, []);
    assert.equal(dom.find('h1')?.textContent, 'Download loops');
  });
});

test('nothing is auto-selected: the list renders and no job is fetched until a song is picked', async () => {
  const LoopsView = await loadLoopsView();
  const { calls, deps } = harness({ songs: SONGS, jobs: { [FRESH]: { kind: 'ok', job: doneJob(FRESH, [loopRow('a', false)]) } } });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await settle(dom);
    const rows = dom.findAll('[data-testid="lp-song"]');
    assert.equal(rows.length, 2);
    assert.deepEqual(calls.fetchJob, [], 'a job was fetched before anyone picked one');
    assert.ok(!dom.find('[data-testid="lp-job"]'));
    assert.ok(rows.every((r) => r.getAttribute('aria-pressed') === 'false'));

    await dom.act(() => rows[0].click());
    await settle(dom);
    assert.deepEqual(calls.fetchJob, [FRESH]);
    assert.deepEqual(calls.setUrl, [FRESH], 'the address bar did not follow the pick');
    assert.equal(rows[0].getAttribute('aria-pressed'), 'true');
  });
});

test('24h: the list marks a song older than 24 hours as closed and a fresh one with its time left', async () => {
  const LoopsView = await loadLoopsView();
  const { deps } = harness({ songs: SONGS });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await settle(dom);
    const [fresh, old] = dom.findAll('[data-testid="lp-song"]');
    assert.equal(fresh.getAttribute('data-open'), 'true');
    assert.match(fresh.textContent, /loops close in 22 hours/);
    assert.match(fresh.textContent, /split 2 hours ago/);
    assert.equal(old.getAttribute('data-open'), 'false');
    assert.match(old.textContent, /loops closed/);
    assert.match(old.textContent, /split 30 hours ago/);
  });
});

test('24h: picking an old song shows Cut DISABLED with the plain reason, WITHOUT a request', async () => {
  const LoopsView = await loadLoopsView();
  const { calls, deps } = harness({ songs: SONGS });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await settle(dom);
    await dom.act(() => dom.findAll('[data-testid="lp-song"]')[1].click());
    await settle(dom);

    assert.deepEqual(calls.fetchJob, [], 'an old song was fetched; the API can only answer 404');
    const closed = dom.find('[data-testid="lp-closed"]');
    assert.ok(closed, 'no closed state');
    assert.equal(closed.getAttribute('data-reason'), 'expired');
    const btn = closed.querySelector('[data-testid="cut-loops"]');
    assert.equal(btn.disabled, true, 'the Cut control is live on a song older than 24 hours');
    assert.equal(btn.getAttribute('aria-describedby'), 'lp-closed-why');
    const why = dom.find('#lp-closed-why').textContent;
    assert.match(why, /within 24 hours/);
    assert.match(why, /on our end/);
    assert.doesNotMatch(why, /on our side/);
    assert.ok(!dom.find('[data-testid="loop-results"]'));
  });
});

test('a done job with uncut loops mounts LoopResults for THAT job, open, after one stems check', async () => {
  globalThis.__loopResultsMounts.length = 0;
  const LoopsView = await loadLoopsView();
  const job = doneJob(FRESH, [loopRow('a', false), loopRow('b', true)]);
  const { calls, deps } = harness({ songs: SONGS, jobs: { [FRESH]: { kind: 'ok', job } } });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps, initialJobId: FRESH }));
    await settle(dom);
    const r = dom.find('[data-testid="loop-results"]');
    assert.ok(r, 'LoopResults not mounted');
    assert.equal(r.getAttribute('data-job'), FRESH);
    assert.equal(r.getAttribute('data-closed'), '');
    assert.deepEqual(calls.fetchStemsState, [FRESH]);
    const last = globalThis.__loopResultsMounts.at(-1);
    assert.equal(last.job.title, 'a-song.mp3', 'the zip is named after the song, as on the old job-page mount');
    assert.equal(dom.find('.lp-to-player')?.getAttribute('href'), `/jobs/${FRESH}`);
  });
});

test('a fully cut job costs no stems request', async () => {
  const LoopsView = await loadLoopsView();
  const job = doneJob(FRESH, [loopRow('a', true)]);
  const { calls, deps } = harness({ songs: SONGS, jobs: { [FRESH]: { kind: 'ok', job } } });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps, initialJobId: FRESH }));
    await settle(dom);
    assert.ok(dom.find('[data-testid="loop-results"]'));
    assert.deepEqual(calls.fetchStemsState, []);
  });
});

test('Story 6.7: a job that kept no stems falls back to its loop view with Cut closed as no_stems', async () => {
  const LoopsView = await loadLoopsView();
  const job = doneJob(FRESH, [loopRow('a', false)]);
  const { deps } = harness({ songs: SONGS, jobs: { [FRESH]: { kind: 'ok', job } }, stems: 'unavailable' });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps, initialJobId: FRESH }));
    await settle(dom);
    assert.equal(dom.find('[data-testid="loop-results"]')?.getAttribute('data-closed'), 'no_stems');
  });
});

test('a stems check that fails does NOT close the control (the server stays the authority)', async () => {
  const LoopsView = await loadLoopsView();
  const job = doneJob(FRESH, [loopRow('a', false)]);
  const { deps } = harness({ songs: SONGS, jobs: { [FRESH]: { kind: 'ok', job } }, stems: null });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps, initialJobId: FRESH }));
    await settle(dom);
    assert.equal(dom.find('[data-testid="loop-results"]')?.getAttribute('data-closed'), '');
  });
});

test('a pasted link to a song this browser has never seen, answered 404, is closed as not_found', async () => {
  const LoopsView = await loadLoopsView();
  const { calls, deps } = harness({ songs: SONGS });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await settle(dom);
    const input = dom.find('#lp-paste-input');
    await dom.act(async () => {
      setNativeValue(input, `https://stem-loops.com/jobs/${STRANGER.toUpperCase()}`);
    });
    await dom.act(() =>
      dom.find('form.lp-paste').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    await settle(dom);
    assert.deepEqual(calls.fetchJob, [STRANGER], 'the pasted id was not lowercased or not used');
    assert.equal(dom.find('[data-testid="lp-closed"]')?.getAttribute('data-reason'), 'not_found');
    assert.equal(dom.find('[data-testid="cut-loops"]').disabled, true);
  });
});

test('a song in the list that the API no longer has is called expired, not "not found"', async () => {
  const LoopsView = await loadLoopsView();
  // In the list as 23h old (open by this browser's clock), but the server has swept it.
  const { deps } = harness({ songs: [{ id: FRESH, at: NOW - 23 * HOUR }] });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps, initialJobId: FRESH }));
    await settle(dom);
    assert.equal(dom.find('[data-testid="lp-closed"]')?.getAttribute('data-reason'), 'expired');
  });
});

test('pasting something that is not a song link says so and fetches nothing', async () => {
  const LoopsView = await loadLoopsView();
  const { calls, deps } = harness({ songs: SONGS });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await settle(dom);
    await dom.act(async () => {
      setNativeValue(dom.find('#lp-paste-input'), 'https://youtube.com/watch?v=abc');
    });
    await dom.act(() =>
      dom.find('form.lp-paste').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    await settle(dom);
    assert.ok(dom.find('#lp-paste-error'), 'no error for a non-song link');
    assert.equal(dom.find('#lp-paste-input').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(calls.fetchJob, []);
  });
});

test('a job still processing, one that failed, and one with no loops each say so, without LoopResults', async () => {
  const LoopsView = await loadLoopsView();
  for (const [job, expect] of [
    [{ ...doneJob(FRESH, []), status: 'separating' }, /still being split/],
    [{ ...doneJob(FRESH, []), status: 'failed' }, /did not finish splitting/],
    [doneJob(FRESH, []), /no steady beat/],
  ]) {
    const { deps } = harness({ songs: SONGS, jobs: { [FRESH]: { kind: 'ok', job } } });
    await withDom(async (dom) => {
      await dom.mount(React.createElement(LoopsView, { deps, initialJobId: FRESH }));
      await settle(dom);
      assert.match(dom.find('[data-testid="lp-job"]').textContent, expect, job.status);
      assert.ok(!dom.find('[data-testid="loop-results"]'), job.status);
    });
  }
});

test('a failed read offers Try again, and Try again really fetches again', async () => {
  const LoopsView = await loadLoopsView();
  const job = doneJob(FRESH, [loopRow('a', true)]);
  const { calls, deps } = harness({ songs: SONGS });
  let n = 0;
  deps.fetchJob = async (id) => {
    calls.fetchJob.push(id);
    n += 1;
    return n === 1 ? { kind: 'error' } : { kind: 'ok', job };
  };
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps, initialJobId: FRESH }));
    await settle(dom);
    const alert = dom.find('.lp-error');
    assert.ok(alert, 'no error state');
    assert.match(alert.textContent, /on our end/);
    await dom.act(() => alert.querySelector('button').click());
    await settle(dom);
    assert.equal(calls.fetchJob.length, 2);
    assert.ok(dom.find('[data-testid="loop-results"]'));
  });
});
