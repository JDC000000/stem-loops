/**
 * LoopResults under on-demand cutting (migration 033) — mounted and CLICKED.
 *
 * `renderToStaticMarkup` renders the initial state and never runs a handler, so
 * a gate built on it would be satisfied forever by the idle view and would stay
 * green on a component that fired a cut request on mount. These tests mount the
 * REAL component in happy-dom, replace only its three outside-world calls with
 * counters, and read those counters BEFORE the click as well as after. "Nothing
 * is requested until the button is pressed" is the whole product rule here, and
 * it is only provable from the before-reading.
 *
 * What this harness cannot see (helpers/dom.mjs header): layout and paint. No
 * assertion here is about geometry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The real LoopResults, with LoopCard and zipLoops replaced at the import seam.
 *
 * Compiled to a real file under node_modules/.cache rather than imported as a
 * `data:` URL, and that is not a style choice: a `data:` module has no base URL,
 * so `react` and `react/jsx-runtime` -- which the JSX transform emits -- cannot
 * be resolved from one at all. (lib/stem-keys.ts's header records the same trap
 * from the other direction.) This is the repo's established route for getting a
 * .tsx into node; see test/helpers/render-chrome.mjs.
 */
async function loadLoopResults() {
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const outDir = mkdtempSync(join(cache, 'loops-results-'));

  const stub = (name, src) => {
    const f = join(outDir, `${name}.mjs`);
    writeFileSync(f, src);
    return pathToFileURL(f).href;
  };
  const cardUrl = stub(
    'loop-card',
    `import { jsx } from 'react/jsx-runtime';
     export const LoopCard = ({ loop }) => jsx('div', {
       'data-testid': 'loop-card',
       'data-stem': loop.stem,
       'data-signed': String(Boolean(loop.signed_url)),
     });`,
  );
  const zipUrl = stub('zip-loops', `export const downloadLoopPack = async () => {};`);

  const js = ts
    .transpileModule(readFileSync(join(WEB, 'src/components/LoopResults.tsx'), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText.replace(/from ['"]@\/components\/LoopCard['"]/g, `from '${cardUrl}'`)
    .replace(/from ['"]@\/lib\/zipLoops['"]/g, `from '${zipUrl}'`);

  const out = join(outDir, 'LoopResults.mjs');
  writeFileSync(out, js);
  return await import(pathToFileURL(out).href);
}

const loop = (id, stem, cut) => ({
  id,
  stem,
  section_label: 'verse',
  energy_class: 'mid',
  start_sec: 0,
  end_sec: 8,
  start_bar: 0,
  bar_count: 4,
  r2_key: `job/${stem}/4bar_verse_0000.wav`,
  filename: `${id}.wav`,
  created_at: 'now',
  cut_at: cut ? '2026-11-11T00:00:00.000Z' : null,
  signed_url: cut ? `https://signed/${id}` : null,
});

const job = (loops) => ({
  id: '33333333-3333-4333-8333-333333333333',
  status: 'done',
  bpm: 120,
  musical_key: 'C major',
  title: 'A Song',
  created_at: 'now',
  updated_at: 'now',
  expires_at: 'later',
  loops,
});

/** Counters in place of the component's three outside-world calls. */
function counters() {
  const calls = { requestCut: [], refresh: 0, zip: 0 };
  return {
    calls,
    deps: {
      requestCut: async (jobId) => {
        calls.requestCut.push(jobId);
      },
      refresh: async () => {
        calls.refresh += 1;
      },
      zip: async () => {
        calls.zip += 1;
      },
    },
  };
}

test('nothing is requested on mount, and the cut happens only on the click', async () => {
  const { LoopResults } = await loadLoopResults();
  const { calls, deps } = counters();
  const loops = [loop('a', 'drums', false), loop('b', 'bass', false), loop('c', 'keys', false)];

  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopResults, { job: job(loops), deps }));

    // BEFORE the click. This is the reading that proves the product rule.
    assert.deepEqual(calls.requestCut, [], 'a cut was requested without anyone asking');
    assert.equal(calls.zip, 0);
    assert.equal(dom.findAll('[data-testid="loop-card"]').length, 0, 'uncut loops must not render as downloads');
    assert.equal(dom.find('[data-testid="zip-loops"]'), null, 'nothing to download yet');

    const button = dom.find('[data-testid="cut-loops"]');
    assert.ok(button, 'there is no way to ask for the cut');
    assert.match(button.textContent, /Cut 3 loops/);
    assert.equal(button.disabled, false);

    // THE CLICK.
    await dom.act(() => button.click());

    assert.deepEqual(
      calls.requestCut,
      ['33333333-3333-4333-8333-333333333333'],
      'the click must POST exactly one cut request, for THIS job',
    );
    await dom.unmountAll();
  });
});

test('mid-flight the button is busy, disabled and says so', async () => {
  const { LoopResults } = await loadLoopResults();
  const loops = [loop('a', 'drums', false), loop('b', 'bass', false)];
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const calls = [];
  const deps = {
    requestCut: async (id) => {
      calls.push(id);
      await held; // hold the request open so the busy state is observable
    },
    refresh: async () => {},
    zip: async () => {},
  };

  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopResults, { job: job(loops), deps }));
    const button = dom.find('[data-testid="cut-loops"]');
    await dom.act(() => button.click());

    const busy = dom.find('[data-testid="cut-loops"]');
    assert.match(busy.textContent, /Cutting…/);
    assert.equal(busy.getAttribute('aria-busy'), 'true');
    assert.equal(busy.disabled, true, 'a second click must not queue a second request');
    assert.match(dom.find('[data-testid="cut-explainer"]').textContent, /Cutting 2 /);
    // Exactly ONE request is in flight — a mutant that dropped the `disabled`
    // and re-fired on re-render would show two here.
    assert.equal(calls.length, 1);

    release();
    await dom.act(async () => {});
    await dom.unmountAll();
  });
});

test('a failed request surfaces an alert and leaves the button pressable again', async () => {
  const { LoopResults } = await loadLoopResults();
  const deps = {
    requestCut: async () => {
      throw new Error('503');
    },
    refresh: async () => {},
    zip: async () => {},
  };
  await withDom(async (dom) => {
    await dom.mount(
      React.createElement(LoopResults, { job: job([loop('a', 'drums', false)]), deps }),
    );
    await dom.act(() => dom.find('[data-testid="cut-loops"]').click());

    const alert = dom.find('[data-testid="cut-error"]');
    assert.ok(alert, 'a failed cut must say so');
    assert.equal(alert.getAttribute('role'), 'alert');
    const button = dom.find('[data-testid="cut-loops"]');
    assert.equal(button.disabled, false, 'a failure must not leave the button dead');
    assert.match(button.textContent, /Cut 1 loops/);
    await dom.unmountAll();
  });
});

test('once every loop is cut the download view returns, unchanged', async () => {
  const { LoopResults } = await loadLoopResults();
  const { calls, deps } = counters();
  const loops = [
    loop('a', 'drums', true),
    loop('b', 'bass', true),
    loop('c', 'keys', true),
  ];
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopResults, { job: job(loops), deps }));

    assert.equal(dom.find('[data-testid="cut-loops"]'), null, 'nothing left to cut');
    assert.equal(dom.find('[data-testid="cut-explainer"]'), null);
    const cards = dom.findAll('[data-testid="loop-card"]');
    assert.equal(cards.length, 3);
    // Every rendered card has a usable URL — the point of gating on cut_at.
    assert.deepEqual(
      cards.map((c) => c.getAttribute('data-signed')),
      ['true', 'true', 'true'],
    );

    const zip = dom.find('[data-testid="zip-loops"]');
    assert.ok(zip);
    await dom.act(() => zip.click());
    assert.equal(calls.zip, 1);
    assert.deepEqual(calls.requestCut, []);
    await dom.unmountAll();
  });
});

test('a partially cut job offers the rest AND the cards it already has', async () => {
  const { LoopResults } = await loadLoopResults();
  const { deps } = counters();
  const loops = [
    loop('a', 'drums', true),
    loop('b', 'bass', false),
    loop('c', 'keys', false),
    loop('d', 'vocals', true),
  ];
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopResults, { job: job(loops), deps }));

    // Scoped to the grid, so nothing outside it is counted.
    const grid = dom.find('.loop-grid');
    const cards = [...grid.querySelectorAll('[data-testid="loop-card"]')];
    assert.equal(cards.length, 2, 'only the CUT loops may render as downloads');
    assert.deepEqual(
      cards.map((c) => c.getAttribute('data-stem')).sort(),
      ['drums', 'vocals'],
    );
    assert.deepEqual(cards.map((c) => c.getAttribute('data-signed')), ['true', 'true']);

    // The stem tabs are scoped to what is actually downloadable, so a tab can
    // never select an empty view.
    const tabs = dom.findAll('.jp-filter').map((t) => t.textContent);
    assert.deepEqual(tabs, ['all', 'drums', 'vocals']);

    assert.match(dom.find('[data-testid="cut-loops"]').textContent, /Cut 2 loops/);
    await dom.unmountAll();
  });
});

test('isCut treats a missing cut_at the same as an explicit null', async () => {
  // The API returns null; a client-side object built without the field would be
  // undefined. Both must mean "not cut" — the opposite default would present a
  // 404 URL as a download.
  const { isCut } = await loadLoopResults();
  assert.equal(isCut({ cut_at: null }), false);
  assert.equal(isCut({}), false);
  assert.equal(isCut({ cut_at: undefined }), false);
  assert.equal(isCut({ cut_at: '2026-11-11T00:00:00.000Z' }), true);
});

// ═══ W4 overnight browser journey j1 (2026-11-12): the cut's progress poll ════
// The default `refresh` was `window.location.reload()`, every CUT_POLL_MS while a
// cut ran. A reload resets `cutting` to false, so when it landed mid-cut (the worker
// had written 13 of 24 rows) the page came back showing "Loops ready · 13 loops"
// next to "✂ Cut 11 loops", stopped polling, and never showed the other 11, although
// the worker finished them 3 s later. It also re-fetched all six stems every 2.5 s.
// The component now takes the refreshed rows from `refresh(jobId)` and keeps polling
// until nothing is pending, with no reload.

test('cut progress: refreshed rows arrive in place, the cut stays busy until all are cut, then the download view', async () => {
  const { LoopResults } = await loadLoopResults();
  const before = [loop('a', 'drums', false), loop('b', 'bass', false)];
  const partial = [loop('a', 'drums', true), loop('b', 'bass', false)];
  const done = [loop('a', 'drums', true), loop('b', 'bass', true)];
  const replies = [partial, done];
  const asked = [];
  const deps = {
    requestCut: async () => {},
    refresh: async (jobId) => {
      asked.push(jobId);
      return replies.shift() ?? done;
    },
    zip: async () => {},
  };
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopResults, { job: job(before), deps }));
    await dom.act(() => dom.find('[data-testid="cut-loops"]').click());

    await dom.advance(2600);
    assert.equal(asked[0], '33333333-3333-4333-8333-333333333333', 'refresh must be asked for THIS job');
    assert.equal(dom.findAll('[data-testid="loop-card"]').length, 1, 'the first cut row must appear without a reload');
    const busy = dom.find('[data-testid="cut-loops"]');
    assert.ok(busy, 'one loop is still pending');
    assert.match(busy.textContent, /Cutting…/, 'a half-finished cut must still read as cutting, not offer "Cut 1 loops"');

    await dom.advance(2600);
    assert.equal(dom.findAll('[data-testid="loop-card"]').length, 2);
    assert.equal(dom.find('[data-testid="cut-loops"]'), null);
    assert.ok(dom.find('[data-testid="zip-loops"]'), 'all cut: the download view returns');
    await dom.unmountAll();
  });
});

test('cut progress: a refresh that returns the same rows keeps polling (no stall on an unchanged count)', async () => {
  const { LoopResults } = await loadLoopResults();
  const before = [loop('a', 'drums', false)];
  let n = 0;
  const deps = {
    requestCut: async () => {},
    refresh: async () => {
      n += 1;
      return n < 3 ? before : [loop('a', 'drums', true)];
    },
    zip: async () => {},
  };
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopResults, { job: job(before), deps }));
    await dom.act(() => dom.find('[data-testid="cut-loops"]').click());
    for (let i = 0; i < 4; i++) await dom.advance(2600);
    assert.ok(n >= 3, `refresh was asked ${n} times; an unchanged reply must not end the poll`);
    assert.equal(dom.findAll('[data-testid="loop-card"]').length, 1);
    await dom.unmountAll();
  });
});

test('the default refresh reads GET /api/jobs/:id and never reloads the page', () => {
  const src = readFileSync(join(WEB, 'src/components/LoopResults.tsx'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /location\.reload\s*\(/, 'a reload resets the cut state mid-cut');
  assert.match(code, /fetch\(\s*`\/api\/jobs\/\$\{jobId\}`/);
});
