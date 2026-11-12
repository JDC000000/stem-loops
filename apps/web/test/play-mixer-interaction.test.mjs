// Mixer, MOUNTED AND DRIVEN. The companion file play-mixer.test.mjs renders the
// component with `renderToStaticMarkup` and says so at its head: it covers first
// paint and every exported pure function, and it explicitly cannot cover a
// pointer, a key or a click. This file is that half, over test/helpers/dom.mjs
// (happy-dom, real React effects, real events).
//
// WHY IT EXISTS. The same control, built against the same design on a canvas,
// shipped DEAD FADERS for two review rounds: `onInput` absent, the level a
// hardcoded constant, and dragging one fader then muting another reset the
// first. `renderToStaticMarkup` cannot see any of that -- the markup of a live
// fader and a dead one are identical. Every assertion below drives the thing.
//
// WHAT THIS FILE STILL CANNOT DO, because dom.mjs says so at its own head:
// LAYOUT. `getBoundingClientRect()` and every box metric are 0 under happy-dom.
// Nothing here is evidence about width, height, overflow or contrast. Those
// were hand-measured in Chromium and the figures are in the PR; they are gated
// by nothing, and saying so is the honest version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'play-mixer-int-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

const typesMod = put('play-types.mjs', toJs(read('src/lib/play/types.ts')));
const cssMod = put(
  'mixer-styles.mjs',
  'export default new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });',
);
writeFileSync(
  join(dir, 'Mixer.mjs'),
  toJs(read('src/components/play/Mixer.tsx'), true)
    .replace(/from ['"]@\/lib\/play\/types['"]/g, `from '${typesMod}'`)
    .replace(/from ['"]\.\/Mixer\.module\.css['"]/g, `from '${cssMod}'`),
);

const React = (await import('react')).default;
const Mixer = await import(pathToFileURL(join(dir, 'Mixer.mjs')).href);
const { PLAYABLE_STEMS } = await import(pathToFileURL(join(dir, 'play-types.mjs')).href);

const { stemEnvelope, ENVELOPE_BARS, ENVELOPE_MIN_PCT, ENVELOPE_MAX_PCT } = Mixer;

const stem = (name, over = {}) => ({
  name,
  availability: 'ready',
  gain: 0.5,
  muted: false,
  soloed: false,
  effectivelySilent: false,
  ...over,
});
const allReady = (over = {}) => PLAYABLE_STEMS.map((n) => stem(n, over[n] ?? {}));

/** Mount with recording callbacks; returns the dom api plus the call logs. */
async function mounted(dom, props = {}) {
  const calls = { gain: [], mute: [], solo: [] };
  const host = await dom.mount(
    React.createElement(Mixer.default, {
      stems: allReady(props.over),
      onGain: (s, g) => calls.gain.push([s, g]),
      onMute: (s, m) => calls.mute.push([s, m]),
      onSolo: (s, v) => calls.solo.push([s, v]),
      jobId: props.jobId,
    }),
  );
  return { host, calls };
}

/** Set a range input's value and fire the event React listens for. */
async function setFader(dom, input, percent) {
  await dom.act(async () => {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, String(percent));
    else input.value = String(percent);
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  });
}

// ─── the faders are alive ────────────────────────────────────────────────────

test('a fader move reaches onGain, with the stem and the level the user chose', async () => {
  await withDom(async (dom) => {
    const { calls } = await mounted(dom);
    const faders = dom.findAll('input[type="range"]');
    assert.equal(faders.length, PLAYABLE_STEMS.length, 'six real range inputs');

    await setFader(dom, faders[0], 30);
    // the emit is rAF-coalesced on purpose, so nothing has landed yet…
    assert.deepEqual(calls.gain, [], 'the drag is coalesced, not emitted per event');
    await dom.nextFrame();

    assert.equal(calls.gain.length, 1, 'exactly one emit per stem per frame');
    const [name, gain] = calls.gain[0];
    assert.equal(name, PLAYABLE_STEMS[0]);
    // 30% of the 0..1 range the engine speaks, not the 0..100 the slider does
    assert.ok(Math.abs(gain - 0.3) < 1e-9, `expected 0.3, got ${gain}`);
  });
});

test('a continuous drag emits ONCE per frame with the last value, and the release lands', async () => {
  await withDom(async (dom) => {
    const { calls } = await mounted(dom);
    const fader = dom.findAll('input[type="range"]')[1];

    for (const p of [40, 45, 52, 61]) await setFader(dom, fader, p);
    await dom.nextFrame();
    assert.equal(calls.gain.length, 1, 'four input events, one emit');
    assert.ok(Math.abs(calls.gain[0][1] - 0.61) < 1e-9, 'last value wins');

    // the value the user LET GO of must land even without waiting a frame
    await setFader(dom, fader, 77);
    await dom.pointer('pointerup', fader);
    assert.equal(calls.gain.length, 2, 'pointerup flushes');
    assert.ok(Math.abs(calls.gain[1][1] - 0.77) < 1e-9);

    // A flush empties the queue but leaves the frame it already armed. Drain
    // it: the harness fails a test that leaves one pending, and the drained
    // frame must be a NO-OP -- a second emit here would mean the release was
    // sent twice, which is exactly the double-send the coalescer exists to stop.
    await dom.nextFrame();
    assert.equal(calls.gain.length, 2, 'the already-armed frame emits nothing more');
  });
});

test('the thumb follows the pointer while the engine has not caught up', async () => {
  await withDom(async (dom) => {
    // A controlled `value` plus a throttled callback makes the thumb stutter
    // backwards under the finger unless the component holds a local draft.
    // `stems` here NEVER changes, i.e. the engine never answers.
    const { host } = await mounted(dom);
    const fader = dom.findAll('input[type="range"]')[2];
    assert.equal(fader.value, '50', 'starts at the snapshot value');
    await setFader(dom, fader, 12);
    assert.equal(fader.value, '12', 'the thumb stays where the user put it');
    await dom.nextFrame();
    assert.equal(fader.value, '12', 'and does not snap back a frame later');
    assert.ok(host);
  });
});

test('dragging one fader then muting ANOTHER does not reset the first', async () => {
  // This is the canvas bug, verbatim, as a gate. The mute must flush the
  // queued gain rather than race it, and the two emits must arrive in order.
  await withDom(async (dom) => {
    const { calls } = await mounted(dom);
    const faders = dom.findAll('input[type="range"]');
    const mutes = dom.findAll('button[data-role="mute"]');

    await setFader(dom, faders[0], 30); // queued, not yet emitted
    assert.deepEqual(calls.gain, [], 'still queued');

    await dom.act(async () => mutes[3].click()); // mute a DIFFERENT stem

    assert.equal(calls.gain.length, 1, 'the queued gain was flushed, not dropped');
    assert.equal(calls.gain[0][0], PLAYABLE_STEMS[0]);
    assert.ok(Math.abs(calls.gain[0][1] - 0.3) < 1e-9, 'at the level the user set');
    assert.deepEqual(calls.mute, [[PLAYABLE_STEMS[3], true]]);
    // and the fader the user was holding still shows their value
    assert.equal(faders[0].value, '30');

    // the frame the drag armed is still queued; it must add nothing
    await dom.nextFrame();
    assert.equal(calls.gain.length, 1, 'the flushed gain is not sent twice');
    assert.equal(faders[0].value, '30', 'and the level did not snap back');
  });
});

test('M and S report the stem and the state they are moving TO', async () => {
  await withDom(async (dom) => {
    const { calls } = await mounted(dom, { over: { bass: { muted: true } } });
    const byStem = (role, name) =>
      dom.findAll(`[data-stem="${name}"] button[data-role="${role}"]`)[0];

    await dom.act(async () => byStem('mute', 'drums').click());
    assert.deepEqual(calls.mute, [['drums', true]], 'an unmuted stem mutes');

    await dom.act(async () => byStem('mute', 'bass').click());
    assert.deepEqual(calls.mute[1], ['bass', false], 'a muted stem unmutes');

    await dom.act(async () => byStem('solo', 'vocals').click());
    assert.deepEqual(calls.solo, [['vocals', true]]);
    // aria-pressed is the state, and it comes from props rather than a local
    // toggle -- the engine owns it, so an unanswered click must NOT flip it
    assert.equal(byStem('mute', 'drums').getAttribute('aria-pressed'), 'false');
    assert.equal(byStem('mute', 'bass').getAttribute('aria-pressed'), 'true');
  });
});

test('an unavailable stem is inert: no fader, no mute, no solo reaches the engine', async () => {
  await withDom(async (dom) => {
    const { calls } = await mounted(dom, { over: { keys: { availability: 'encode_failed' } } });
    const fader = dom.findAll('[data-stem="keys"] input[type="range"]')[0];
    const mute = dom.findAll('[data-stem="keys"] button[data-role="mute"]')[0];
    assert.equal(fader.disabled, true);
    assert.equal(mute.disabled, true);
    await dom.act(async () => mute.click());
    await dom.nextFrame();
    assert.deepEqual(calls.mute, [], 'a disabled control emits nothing');
    assert.deepEqual(calls.gain, []);
    // …and it still SAYS WHY, in text, not only as a dimmed box
    const note = dom.findAll('[data-stem="keys"] p')[0];
    assert.match(note.textContent, /failed to encode/i);
  });
});

// ─── the heading ─────────────────────────────────────────────────────────────

test('the mixer has a real heading in the document outline', async () => {
  await withDom(async (dom) => {
    await mounted(dom);
    const h2 = dom.find('section h2');
    assert.ok(h2, 'a six-channel control surface is not an unlabelled section');
    assert.equal(h2.textContent.trim(), 'Mixer');
    // the region keeps its own, more specific, accessible name
    assert.equal(dom.find('section').getAttribute('aria-label'), 'Stem mixer');
  });
});

// ─── the envelope ────────────────────────────────────────────────────────────

test('the envelope is stable per song+stem and never the same twice', () => {
  // Properties, NOT a recomputation of the component's own rule with the
  // component's own function: each assertion below would still fail if
  // `stemEnvelope` were replaced by a different stable function, except the
  // golden row, which pins this one.
  const a1 = stemEnvelope('job-7f3a', 'drums');
  const a2 = stemEnvelope('job-7f3a', 'drums');
  assert.deepEqual(a1, a2, 'the same song and stem always draw the same figure');

  assert.notDeepEqual(
    stemEnvelope('job-7f3a', 'drums'),
    stemEnvelope('job-0001', 'drums'),
    'two songs must not render identically -- that is the whole point of the seed',
  );
  assert.notDeepEqual(
    stemEnvelope('job-7f3a', 'drums'),
    stemEnvelope('job-7f3a', 'vocals'),
    'two stems of one song must not render identically either',
  );

  // no collisions across a realistic number of jobs
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(JSON.stringify(stemEnvelope(`job-${i}`, 'drums')));
  assert.equal(seen.size, 500, 'every one of 500 job ids drew a different figure');

  // every bar is inside the declared band, for every stem
  for (const name of PLAYABLE_STEMS) {
    const bars = stemEnvelope('job-7f3a', name);
    assert.equal(bars.length, ENVELOPE_BARS);
    for (const v of bars) {
      assert.ok(Number.isInteger(v), `${name}: ${v} is not a whole percent`);
      assert.ok(
        v >= ENVELOPE_MIN_PCT && v <= ENVELOPE_MAX_PCT,
        `${name}: ${v} outside ${ENVELOPE_MIN_PCT}..${ENVELOPE_MAX_PCT}`,
      );
    }
    // never a flat line: a figure of identical bars is a box, not a waveform
    assert.ok(new Set(bars).size > 4, `${name}: ${new Set(bars).size} distinct heights`);
  }
});

test('the envelope is pinned to literal values, so a change to it has to be deliberate', () => {
  // GOLDEN ROWS. Captured once from a run and written down, not recomputed
  // here -- a gate that recomputes with the same function proves only that the
  // code applied its own rule. If the generator changes, these fail.
  assert.deepEqual(
    stemEnvelope('job-7f3a', 'drums'),
    [56, 44, 52, 66, 58, 92, 69, 90, 90, 73, 69, 67, 61, 79, 67, 44],
  );
  assert.deepEqual(
    stemEnvelope('job-7f3a', 'vocals'),
    [69, 83, 91, 90, 65, 90, 60, 75, 69, 44, 54, 42, 35, 47, 43, 42],
  );
  assert.deepEqual(
    stemEnvelope('job-0001', 'drums'),
    [39, 52, 66, 55, 70, 59, 95, 65, 73, 80, 84, 76, 65, 77, 73, 42],
  );
});

test('the bar count fits the narrowest column the mixer actually gets', () => {
  // The bars are flex items with a 1px floor and a 1px gap, so N bars need at
  // least 2N-1 px before anything can shrink. The width on the right-hand side
  // is MEASURED IN CHROMIUM and written down here as a literal; it is not
  // derived from the stylesheet, so this cannot agree with itself.
  //
  //   narrowest slot = the six-across channel at a 360px viewport,
  //                    48.66px, less the channel's two 1px borders = 46.66px
  //
  // The design canvas's 28 bars need 55px and overflowed this column by 3.17px
  // at 360, 1.92px at 375 and 0.67px at 390, each spilling into the next
  // channel. That is what this number exists to stop happening again.
  const NARROWEST_SLOT_PX = 46; // floor of the 46.66px measured in Chromium
  assert.ok(
    2 * ENVELOPE_BARS - 1 <= NARROWEST_SLOT_PX,
    `${ENVELOPE_BARS} bars need ${2 * ENVELOPE_BARS - 1}px of a ${NARROWEST_SLOT_PX}px slot`,
  );
});

test('the rendered envelope carries its heights as custom properties, not as inline layout', async () => {
  // Two things at once. (1) The figure is really in the DOM, one span per bar
  // per channel. (2) The ONLY thing set from JS is a custom property: an inline
  // `height` would beat the stylesheet, and a rule that cannot win is the bug
  // this project has hit four times ("rule present, no effect").
  await withDom(async (dom) => {
    await mounted(dom, { jobId: 'job-7f3a' });
    for (const name of PLAYABLE_STEMS) {
      const wave = dom.find(`[data-testid="mixer-envelope-${name}"]`);
      assert.ok(wave, `${name} has no envelope`);
      assert.equal(wave.getAttribute('aria-hidden'), 'true', 'decorative, so hidden from AT');
      const bars = [...wave.children];
      assert.equal(bars.length, ENVELOPE_BARS);

      const expected = stemEnvelope('job-7f3a', name);
      bars.forEach((bar, i) => {
        assert.equal(
          bar.style.getPropertyValue('--mx-bar').trim(),
          `${expected[i]}%`,
          `${name} bar ${i}`,
        );
        assert.equal(bar.style.height, '', 'no inline height -- the stylesheet owns it');
        for (const banned of ['display', 'gap', 'flex', 'order', 'gridTemplateColumns', 'fontSize']) {
          assert.equal(bar.style[banned], '', `inline ${banned} would outrank any query`);
        }
      });
    }
  });
});

test('a fader move does not redraw the envelope', async () => {
  // The engine republishes `stems` every frame while playing. If the figure
  // were rebuilt from that, every channel would re-render 60 times a second
  // and the bars would crawl. Same song in, same bars out.
  await withDom(async (dom) => {
    const { host } = await mounted(dom, { jobId: 'job-7f3a' });
    const before = [...dom.find('[data-testid="mixer-envelope-drums"]').children].map((b) =>
      b.style.getPropertyValue('--mx-bar'),
    );
    await dom.rerender(
      host,
      React.createElement(Mixer.default, {
        stems: PLAYABLE_STEMS.map((n) => stem(n, { gain: 0.93 })), // a new array
        onGain() {},
        onMute() {},
        onSolo() {},
        jobId: 'job-7f3a',
      }),
    );
    const after = [...dom.find('[data-testid="mixer-envelope-drums"]').children].map((b) =>
      b.style.getPropertyValue('--mx-bar'),
    );
    assert.deepEqual(after, before);

    // but a NEW song does redraw it
    await dom.rerender(
      host,
      React.createElement(Mixer.default, {
        stems: allReady(),
        onGain() {},
        onMute() {},
        onSolo() {},
        jobId: 'job-0001',
      }),
    );
    const other = [...dom.find('[data-testid="mixer-envelope-drums"]').children].map((b) =>
      b.style.getPropertyValue('--mx-bar'),
    );
    assert.notDeepEqual(other, before, 'a different song draws a different figure');
  });
});
