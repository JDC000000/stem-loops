// /loops — THE ON-DEMAND RULE, GATED BY BEHAVIOUR.
//
// The one thing this page promises that a static render cannot show is that
// NOTHING IS PROCESSED UNTIL THE BUTTON IS PRESSED. `renderToStaticMarkup`
// renders the initial state and never runs a handler, so a gate built on it is
// satisfied forever by the idle state and would stay green on a component that
// started decoding six stems on mount. So the real component is mounted in
// happy-dom (test/helpers/dom.mjs — React effects, real events), its outside
// world is replaced with counters, and the counters are read BEFORE the click
// and again AFTER it.
//
// WHAT IS REPLACED AND WHAT IS NOT. LoopsView takes one `deps` object holding
// the four things it reaches outside itself: the song list, the job fetch, the
// stem fetch and the decoder. Nothing else is injectable — the plan, the cut,
// the WAV writer, the markup and every piece of state are the real ones, and
// the production `deps` are the module's own default. A fake that shadowed the
// thing being measured would be the false green this file exists to prevent.
//
// WHAT THIS CANNOT SEE: layout. happy-dom has no layout engine, so "the cards
// are legible at 390px" is unreachable here and is not claimed. Every geometry
// figure in the PR is hand-measured and gated by nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { compile } from './helpers/render-chrome.mjs';
import { withDom } from './helpers/dom.mjs';

const [url] = compile(['app/loops/LoopsView']);
const { default: LoopsView } = await import(url);

const JOB_A = '477fb242-695a-4b29-9373-a26b9067a8fa';
const JOB_B = '9a1c4b7e-2d35-4f08-91aa-6b0f3c8e7d21';
const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];

/** A done job at 120 BPM whose loop rows put bar 1 at t = 0. */
const doneJob = (id) => ({
  id,
  status: 'done',
  bpm: 120,
  musical_key: 'C major',
  original_filename: 'My Song',
  loops: [{ start_sec: '0', start_bar: 0 }],
});

/**
 * The outside world, as counters. Every call is tallied so a gate can assert
 * what was NOT done as readily as what was.
 */
function harness(over = {}) {
  const calls = { job: 0, stems: 0, decode: 0, objectUrl: 0, revokeUrl: 0 };
  let urlSeq = 0;
  const deps = {
    listSongs: () => [
      { id: JOB_A, at: Date.now() },
      { id: JOB_B, at: Date.now() },
    ],
    async fetchJob(id) {
      calls.job += 1;
      return doneJob(id);
    },
    async fetchStems() {
      calls.stems += 1;
      return STEMS.map((name) => ({ name, bytes: new ArrayBuffer(8) }));
    },
    async decode() {
      calls.decode += 1;
      // 20 s of audio at 48 kHz — long enough for every bank, including 8 bars
      // at 120 bpm (16 s).
      return { channels: [new Float32Array(48000 * 20).fill(0.25)], sampleRate: 48000 };
    },
    objectUrl() {
      calls.objectUrl += 1;
      urlSeq += 1;
      return `blob:loops-test/${urlSeq}`;
    },
    revokeUrl() {
      calls.revokeUrl += 1;
    },
    ...over,
  };
  return { calls, deps };
}

const text = (dom) => dom.body.textContent.replace(/\s+/g, ' ').trim();
const buttonLabelled = (dom, label) =>
  dom.findAll('button').find((b) => b.textContent.trim() === label);

/** Click the first song in the picker and let the job load settle. */
async function pickSong(dom, index = 0) {
  const song = dom.findAll('button.lp-song')[index];
  assert.ok(song, 'the song picker rendered no songs');
  await dom.act(() => song.click());
  await dom.act(async () => {});
  return song;
}

// ═════════════════════════════════════════════════════════════════════════
// 1. THE GATE. Nothing is fetched or decoded until the button is pressed.
// ═════════════════════════════════════════════════════════════════════════

test('no stem is fetched or decoded until "Cut loops" is pressed', async () => {
  const { calls, deps } = harness();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    assert.deepEqual(
      { stems: calls.stems, decode: calls.decode, objectUrl: calls.objectUrl },
      { stems: 0, decode: 0, objectUrl: 0 },
      'the page touched audio on mount, before anyone asked for loops',
    );

    await pickSong(dom);
    // The job's own metadata IS read — that is the one small JSON request the
    // idle state costs, and the plan is drawn from it.
    assert.equal(calls.job, 1);
    assert.deepEqual(
      { stems: calls.stems, decode: calls.decode, objectUrl: calls.objectUrl },
      { stems: 0, decode: 0, objectUrl: 0 },
      'choosing a song started the processing work',
    );
    assert.ok(dom.find('[data-testid="lp-not-cut"]'), 'the idle state did not say so');

    const cut = buttonLabelled(dom, 'Cut loops');
    assert.ok(cut, `no "Cut loops" button: ${text(dom)}`);
    await dom.act(() => cut.click());
    await dom.act(async () => {});

    assert.equal(calls.stems, 1, 'the click did not fetch the stems');
    assert.equal(calls.decode, 6, 'the click did not decode all six stems');
    assert.equal(calls.objectUrl, 24, 'the click did not produce 24 downloadable loops');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. The idle state is a real plan, not an empty shell.
// ═════════════════════════════════════════════════════════════════════════

test('the idle state shows all 24 cards with their size and duration', async () => {
  const { deps } = harness();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);

    assert.equal(dom.findAll('article.lp-card').length, 24);
    assert.deepEqual(
      dom.findAll('section.lp-bank').map((s) => s.getAttribute('aria-label')),
      ['1-bar loops', '2-bar loops', '4-bar loops', '8-bar loops'],
    );
    // Six cards per bank, one per stem, in mixer order.
    for (const bank of dom.findAll('section.lp-bank')) {
      assert.deepEqual(
        [...bank.querySelectorAll('article.lp-card')].map((c) => c.getAttribute('data-stem')),
        STEMS,
      );
    }
    // 120 bpm: a 4-bar loop is 8.00 s and 1,152,044 bytes. Worked out by hand,
    // not read back out of the module that produced it.
    const fourBar = dom
      .findAll('section.lp-bank')
      .find((s) => s.getAttribute('aria-label') === '4-bar loops');
    assert.match(fourBar.textContent.replace(/\s+/g, ' '), /8\.00 s · 1\.2 MB/);

    // Idle cards offer no download, and say why rather than looking broken.
    assert.equal(dom.findAll('article.lp-card a[download]').length, 0);
    assert.equal(dom.findAll('article.lp-card .lp-download-idle').length, 24);
    assert.match(text(dom), /24 loops · 6 stems · 1, 2, 4 and 8 bars · 24-bit WAV, 48 kHz · 120 BPM/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Cutting produces real, differently-named files.
// ═════════════════════════════════════════════════════════════════════════

test('after cutting, every card offers its own file with its own name', async () => {
  const { deps } = harness();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);
    await dom.act(() => buttonLabelled(dom, 'Cut loops').click());
    await dom.act(async () => {});

    const links = dom.findAll('article.lp-card a[download]');
    assert.equal(links.length, 24, `only ${links.length} loops are downloadable`);
    for (const a of links) {
      assert.match(a.getAttribute('href'), /^blob:/, 'a card has no file behind it');
    }
    const names = links.map((a) => a.getAttribute('download'));
    assert.equal(new Set(names).size, 24, 'two loops would download over each other');
    assert.ok(names.includes('my-song_drums_4bar_120bpm_c-major.wav'), names.join(' | '));
    assert.ok(names.includes('my-song_vocals_8bar_120bpm_c-major.wav'), names.join(' | '));
    // The idle placeholders are gone — not merely hidden behind a real link.
    assert.equal(dom.findAll('article.lp-card .lp-download-idle').length, 0);
    assert.equal(dom.findAll('[data-testid="lp-not-cut"]').length, 0);
  });
});

test('the cut button reports progress and does not fire twice', async () => {
  // decode is held open, so the component is observed MID-cut rather than only
  // before and after. A mutant that jumped straight to the finished state, or
  // that left the button live during the work, fails here.
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  let decodes = 0;
  const { deps } = harness({
    async decode() {
      decodes += 1;
      await held;
      return { channels: [new Float32Array(48000 * 20)], sampleRate: 48000 };
    },
  });

  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);
    const cut = buttonLabelled(dom, 'Cut loops');
    await dom.act(() => cut.click());
    await dom.act(async () => {});

    const busy = dom.find('button.lp-primary');
    assert.equal(busy.textContent.trim(), 'Cutting…', 'the button never said it was working');
    assert.equal(busy.getAttribute('aria-busy'), 'true');
    assert.ok(busy.hasAttribute('disabled'), 'a second press would start a second cut');
    // Only ONE decode is in flight: they are run one at a time on purpose.
    assert.equal(decodes, 1);

    release();
    await dom.act(async () => {});
    await dom.act(async () => {});
    assert.equal(decodes, 6);
    assert.ok(buttonLabelled(dom, 'Download all (ZIP)'), text(dom));
    assert.ok(buttonLabelled(dom, 'Hide loops'), text(dom));
    assert.equal(buttonLabelled(dom, 'Cut loops'), undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Putting the loops away, and not leaking the files.
// ═════════════════════════════════════════════════════════════════════════

test('"Hide loops" returns to idle and releases every object URL', async () => {
  const { calls, deps } = harness();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);
    await dom.act(() => buttonLabelled(dom, 'Cut loops').click());
    await dom.act(async () => {});
    assert.equal(calls.objectUrl, 24);
    assert.equal(calls.revokeUrl, 0);

    await dom.act(() => buttonLabelled(dom, 'Hide loops').click());
    assert.equal(calls.revokeUrl, 24, 'the blobs were left attached to the document');
    assert.equal(dom.findAll('article.lp-card a[download]').length, 0);
    assert.ok(dom.find('[data-testid="lp-not-cut"]'));
    assert.ok(buttonLabelled(dom, 'Cut loops'), 'there is no way to cut them again');
  });
});

test('choosing another song clears the loops cut from the first', async () => {
  // Leaving song A's 24 cards under song B's heading is the kind of stale view
  // that gets downloaded and only noticed in a DAW.
  const { calls, deps } = harness();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom, 0);
    await dom.act(() => buttonLabelled(dom, 'Cut loops').click());
    await dom.act(async () => {});
    assert.equal(dom.findAll('article.lp-card a[download]').length, 24);

    await pickSong(dom, 1);
    assert.equal(
      dom.findAll('article.lp-card a[download]').length,
      0,
      'the previous song’s loops are still on screen under another song',
    );
    assert.equal(calls.revokeUrl, 24);
    assert.ok(dom.find('[data-testid="lp-not-cut"]'));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Songs that cannot yield loops say so, and still do no work.
// ═════════════════════════════════════════════════════════════════════════

test('a job that is still running offers no cut, and touches no audio', async () => {
  const { calls, deps } = harness({
    async fetchJob(id) {
      return { ...doneJob(id), status: 'separating' };
    },
  });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);
    assert.equal(buttonLabelled(dom, 'Cut loops'), undefined);
    assert.match(text(dom), /still separating/);
    assert.equal(calls.stems, 0);
    assert.equal(calls.decode, 0);
  });
});

test('a job with no usable tempo says so instead of offering a bar grid', async () => {
  const { calls, deps } = harness({
    async fetchJob(id) {
      return { ...doneJob(id), bpm: null };
    },
  });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);
    assert.equal(dom.findAll('article.lp-card').length, 0);
    assert.equal(buttonLabelled(dom, 'Cut loops'), undefined);
    assert.match(text(dom), /could not read a usable tempo/);
    assert.equal(calls.stems, 0);
  });
});

test('an expired song is named as expired, not shown as an empty page', async () => {
  const { deps } = harness({
    async fetchJob() {
      throw new Error('NOT_FOUND');
    },
  });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);
    assert.match(text(dom), /deleted 24 hours after a song is run/);
    assert.equal(dom.findAll('article.lp-card').length, 0);
  });
});

test('a cut that fails partway leaves the page usable and says what happened', async () => {
  const { deps } = harness({
    async fetchStems() {
      return [];
    },
  });
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    await pickSong(dom);
    await dom.act(() => buttonLabelled(dom, 'Cut loops').click());
    await dom.act(async () => {});
    assert.match(text(dom), /no playback stems/);
    // Back to idle, and pressable again rather than stuck on "Cutting…".
    const again = buttonLabelled(dom, 'Cut loops');
    assert.ok(again, text(dom));
    assert.ok(!again.hasAttribute('disabled'));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. The picker, and what it does NOT claim.
// ═════════════════════════════════════════════════════════════════════════

test('nothing is selected until the viewer picks, and a link can be pasted', async () => {
  const { calls, deps } = harness();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoopsView, { deps }));
    // No song is chosen FOR the viewer: the nav deep-link defect this page was
    // built to avoid (see SignedInChrome) starts with auto-selecting one.
    assert.equal(calls.job, 0, 'a song was loaded without anyone choosing it');
    assert.equal(dom.findAll('article.lp-card').length, 0);
    assert.equal(dom.findAll('button.lp-song[aria-pressed="true"]').length, 0);

    const input = dom.find('#lp-paste-input');
    const form = dom.find('form.lp-paste');
    assert.ok(input && form);
    await dom.act(() => {
      // Set through the value setter React tracks, then fire `input`, which is
      // what a controlled input listens for.
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(input, `https://stem-loops.com/jobs/${JOB_B}`);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await dom.act(() => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await dom.act(async () => {});
    assert.equal(calls.job, 1, 'the pasted link did not select that song');
    assert.equal(dom.findAll('article.lp-card').length, 24);
  });
});
