// Player — THE SEAM (apps/web/src/components/play/Player.tsx) plus the two
// properties of its neighbours that the seam depends on.
//
// WHY THIS FILE EXISTS. Six PRs landed a complete play-along player and
// NOTHING imported any of it: `createPlayEngine`, `loadStems`, `Mixer`,
// `Transport` and `SectionLoop` each appeared only in their own defining file,
// and `/jobs/[id]` mounted `<ChordOverlay jobId>` with no `positionSec`, so the
// chord playhead was inert. The defect class here is therefore "the edge does
// not exist", and these tests are aimed at edges, not at pixels.
//
// HARNESS. Same mechanism as test/play-mixer.test.mjs (there is no jsdom, and
// node's --experimental-strip-types loader does not accept `.tsx`): transpile
// with the TypeScript compiler into node_modules/.cache, point the import
// specifiers at the transpiled siblings, stub the CSS modules with a Proxy, and
// server-render to static markup. Mixer, Transport, SectionLoop and sections.ts
// are the REAL modules; only ChordOverlay (which pulls onnxruntime-web) and
// load-stems (which fetches) are stubbed.
//
// WHAT THIS COVERS: every exported pure helper driven directly; the Story 5.3
// copy guard; the engine's snapshot-identity property that the React binding
// depends on; and, by server-rendering the real component, that ChordOverlay is
// mounted WITH a `positionSec` prop and that the page can be server-rendered at
// all.
//
// WHAT IT CANNOT COVER: React effects. `renderToStaticMarkup` never runs them,
// so the 'loading' / 'ready' / 'no-stems' / 'unsupported' phases cannot be
// reached from node at all — reaching them needs a mounted client render. Those
// are verified in real Chrome over CDP; see the PR description for the harness
// and what it showed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { WebAudioPlayEngine } from '../src/lib/play/engine.ts';
import { PLAYABLE_STEMS } from '../src/lib/play/types.ts';

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
const dir = mkdtempSync(join(cache, 'play-player-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

// ─── the module graph ────────────────────────────────────────────────────────

const typesMod = put('play-types.mjs', toJs(read('src/lib/play/types.ts')));
const cssMod = put(
  'styles.mjs',
  'export default new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });',
);

const sectionsMod = put(
  'sections.mjs',
  toJs(read('src/lib/play/sections.ts')).replace(/from ['"]\.\/types['"]/g, `from '${typesMod}'`),
);

const rewriteShared = (js) =>
  js
    .replace(/from ['"]@\/lib\/play\/types['"]/g, `from '${typesMod}'`)
    .replace(/from ['"]@\/lib\/play\/sections['"]/g, `from '${sectionsMod}'`)
    .replace(/from ['"][^'"]*\.module\.css['"]/g, `from '${cssMod}'`);

const mixerMod = put('Mixer.mjs', rewriteShared(toJs(read('src/components/play/Mixer.tsx'), true)));
const transportMod = put(
  'Transport.mjs',
  rewriteShared(toJs(read('src/components/play/Transport.tsx'), true)),
);
const sectionLoopMod = put(
  'SectionLoop.mjs',
  rewriteShared(toJs(read('src/components/play/SectionLoop.tsx'), true)),
);

// ChordOverlay stub. The thing under test is whether `positionSec` is PASSED AT
// ALL — before the seam the prop was absent from the mount — so the stub
// reports the presence of the key separately from its value.
const chordMod = put(
  'ChordOverlay.mjs',
  `import { createElement } from 'react';
   export const ChordOverlay = (props) =>
     createElement('div', {
       'data-testid': 'chord-overlay',
       'data-job-id': String(props.jobId),
       'data-has-position': String(Object.prototype.hasOwnProperty.call(props, 'positionSec')),
       'data-position': String(props.positionSec),
     });
   export default ChordOverlay;`,
);

// load-stems stub: never called in a server render, but the module must exist
// and must export the error class Player narrows on.
const loadStemsMod = put(
  'load-stems.mjs',
  `export class StemLoadError extends Error {
     constructor(code, message, extra = {}) { super(message); this.name = 'StemLoadError'; this.code = code; Object.assign(this, extra); }
   }
   export async function loadStems() { return { sources: [], missing: [] }; }`,
);

const engineMod = put(
  'engine.mjs',
  toJs(read('src/lib/play/engine.ts')).replace(/from ['"]\.\/types\.ts['"]/g, `from '${typesMod}'`),
);

const playerJs = rewriteShared(toJs(read('src/components/play/Player.tsx'), true))
  .replace(/from ['"]@\/components\/ChordOverlay['"]/g, `from '${chordMod}'`)
  .replace(/from ['"]@\/lib\/play\/engine['"]/g, `from '${engineMod}'`)
  .replace(/from ['"]@\/lib\/play\/load-stems['"]/g, `from '${loadStemsMod}'`)
  .replace(/from ['"]\.\/Mixer['"]/g, `from '${mixerMod}'`)
  .replace(/from ['"]\.\/Transport['"]/g, `from '${transportMod}'`)
  .replace(/from ['"]\.\/SectionLoop['"]/g, `from '${sectionLoopMod}'`);
writeFileSync(join(dir, 'Player.mjs'), playerJs);

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const Player = await import(pathToFileURL(join(dir, 'Player.mjs')).href);

const render = (props) =>
  renderToStaticMarkup(React.createElement(Player.default, { jobId: 'job-1', ...props }));

const {
  UNSUPPORTED_BROWSER_MESSAGE,
  UNDECODABLE_MESSAGE,
  NO_STEMS_MESSAGE,
  GENERIC_LOAD_MESSAGE,
  degradedMessage,
  hasWebAudio,
  stemLoadMessage,
} = Player;

const attr = (html, key) => html.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? null;

// ═══ Story 3.3 / 3.4 — the wiring that was missing ═══════════════════════════

test('the chord track is mounted WITH a positionSec prop, not just a jobId', () => {
  const html = render({});
  assert.match(html, /data-testid="chord-overlay"/);
  // The whole defect: the prop was absent from the mount, so the playhead was
  // inert. Presence of the KEY is the assertion; its value is null until the
  // engine is playing.
  assert.equal(attr(html, 'data-has-position'), 'true');
  assert.equal(attr(html, 'data-job-id'), 'job-1');
});

test('positionSec is null while nothing is playing, so the timeline renders as before', () => {
  assert.equal(attr(render({}), 'data-position'), 'null');
});

test('the chord track stays mounted even with no loops and no stems', () => {
  // Story 6.4 / 3.6: a pre-V3-J2 job must still get the chord view it had
  // before the player existed.
  const html = render({ loops: [] });
  assert.match(html, /data-testid="chord-overlay"/);
});

// ═══ the page can be server-rendered ═════════════════════════════════════════

test('Player server-renders without touching window, and shows no transport yet', () => {
  const html = render({ loops: null });
  assert.match(html, /data-testid="player"/);
  assert.equal(attr(html, 'data-phase'), 'idle');
  assert.match(html, /<h1[^>]*>Play along<\/h1>/);
  // Effects have not run, so no engine exists and no mix is shown. A transport
  // rendered here would be a dead control.
  assert.doesNotMatch(html, /data-testid="transport"/);
  assert.doesNotMatch(html, /aria-label="Stem mixer"/);
});

test('Player renders with a hostile loops payload rather than throwing', () => {
  const rows = [null, 42, { section_label: '  ' }, { section_label: 'verse', start_sec: 'nope' }];
  assert.match(render({ loops: rows }), /data-testid="player"/);
});

// ═══ Story 5.1 — say WHICH stem is missing ═══════════════════════════════════

test('degradedMessage: nothing missing is no banner at all', () => {
  assert.equal(degradedMessage([]), null);
  assert.equal(degradedMessage(null), null);
  assert.equal(degradedMessage(undefined), null);
});

test('degradedMessage names the single missing stem, and says the rest still plays', () => {
  const m = degradedMessage(['bass']);
  assert.match(m, /^Bass is not available for this track\./);
  assert.match(m, /Every other stem still plays\./);
  // The point of Story 5.1 is that it is SPECIFIC. A message that does not
  // carry the stem's name fails the story.
  assert.ok(m.includes('Bass'));
});

test('degradedMessage lists two missing stems with "and", not a comma', () => {
  assert.match(degradedMessage(['bass', 'keys']), /^Bass and Keys are not available/);
});

test('degradedMessage lists three or more as a comma list with a final "and"', () => {
  assert.match(
    degradedMessage(['drums', 'bass', 'vocals']),
    /^Drums, Bass and Vocals are not available/,
  );
});

test('degradedMessage covers every stem name the contract knows', () => {
  for (const name of PLAYABLE_STEMS) {
    const m = degradedMessage([name]);
    assert.ok(m.toLowerCase().includes(name), `${name} is not named in "${m}"`);
  }
});

test('degradedMessage ignores junk entries rather than printing "undefined"', () => {
  assert.equal(degradedMessage([null, '', undefined]), null);
  assert.match(degradedMessage([null, 'bass']), /^Bass is not available/);
});

// ═══ Story 5.3 — a specific banner, and NOT the old tab-capture copy ═════════

// The words that appear in src/chord/tab-capture.ts's unsupported messages.
// Every one of them is false for this player: nothing here captures a tab, and
// Edge is not launch scope (Chrome desktop is).
const TAB_CAPTURE_WORDS = [
  'tab capture',
  'tab-audio',
  'tab audio',
  'screen capture',
  'chord overlay',
  'Edge',
];

test('the unsupported-browser copy does not reuse the tab-capture wording', () => {
  for (const message of [UNSUPPORTED_BROWSER_MESSAGE, UNDECODABLE_MESSAGE]) {
    for (const word of TAB_CAPTURE_WORDS) {
      assert.ok(
        !message.toLowerCase().includes(word.toLowerCase()),
        `"${word}" is tab-capture copy and is false for the player: ${message}`,
      );
    }
  }
});

test('the unsupported-browser copy is not byte-identical to any tab-capture message', () => {
  const tabCapture = read('src/chord/tab-capture.ts');
  for (const message of [UNSUPPORTED_BROWSER_MESSAGE, UNDECODABLE_MESSAGE]) {
    assert.ok(!tabCapture.includes(message), 'the player reused a tab-capture string verbatim');
  }
});

test('the unsupported-browser copy names Chrome desktop and points at the loops', () => {
  for (const message of [UNSUPPORTED_BROWSER_MESSAGE, UNDECODABLE_MESSAGE]) {
    assert.match(message, /Chrome/);
    assert.match(message, /desktop|laptop/);
    assert.match(message, /loops/);
  }
});

test('hasWebAudio: a scope with either constructor is supported', () => {
  assert.equal(hasWebAudio({ AudioContext: function () {} }), true);
  assert.equal(hasWebAudio({ webkitAudioContext: function () {} }), true);
});

test('hasWebAudio: a scope without one is not, and nothing throws on a bad scope', () => {
  assert.equal(hasWebAudio({}), false);
  assert.equal(hasWebAudio(null), false);
  assert.equal(hasWebAudio(undefined), false);
  // A non-callable property is not a constructor.
  assert.equal(hasWebAudio({ AudioContext: 'yes' }), false);
  assert.equal(hasWebAudio({ AudioContext: {} }), false);
});

// ═══ Story 6.4 — "no stems" is a fallback, not an error ══════════════════════

test('the no-stems copy explains the fallback without calling it a failure', () => {
  assert.match(NO_STEMS_MESSAGE, /loops/);
  for (const alarming of ['error', 'failed', 'went wrong', 'sorry']) {
    assert.ok(
      !NO_STEMS_MESSAGE.toLowerCase().includes(alarming),
      `Story 6.4 is a fallback, not an error, but the copy says "${alarming}"`,
    );
  }
});

// ═══ loader failures get a sentence a user can act on ════════════════════════

test('stemLoadMessage maps every StemLoadErrorCode, with no "undefined"', () => {
  for (const code of ['RATE_LIMITED', 'NOT_FOUND', 'MANIFEST_FAILED', 'MANIFEST_INVALID', 'ABORTED']) {
    const m = stemLoadMessage(code);
    assert.equal(typeof m, 'string');
    assert.ok(m.length > 0, `${code} has no message`);
    assert.ok(!m.includes('undefined'), `${code} message leaked undefined`);
  }
});

test('stemLoadMessage: a rate limit says to wait, a 404 says the files expired', () => {
  assert.match(stemLoadMessage('RATE_LIMITED'), /minute|fast|capacity/i);
  assert.match(stemLoadMessage('NOT_FOUND'), /24 hours|no longer available/i);
});

test('stemLoadMessage falls back rather than returning undefined for a new code', () => {
  assert.equal(stemLoadMessage('A_CODE_THIS_BUILD_DOES_NOT_KNOW'), GENERIC_LOAD_MESSAGE);
});

// ═══ the engine property the React binding stands on ═════════════════════════
//
// `getSnapshot()` must keep OBJECT IDENTITY while nothing has changed. A fresh
// object per read is what sends a React store binding into a render loop, and
// it also defeats the `Object.is` bail-out that keeps a playing track from
// re-rendering six faders every frame. engine.ts holds this via
// `snapshotsEqual` + a cached snapshot; this pins it.

/** The smallest AudioContext the engine will accept. One channel, so the
 *  mono downmix path returns the decoded buffer unchanged. */
function fakeAudioContext(sampleRate) {
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime() {},
    linearRampToValueAtTime() {},
  });
  const ctx = {
    sampleRate,
    currentTime: 0,
    state: 'running',
    destination: {},
    createGain: () => ({ gain: param(), connect() {}, disconnect() {} }),
    createBufferSource: () => ({
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    }),
    createBuffer: (channels, length, rate) => makeBuffer(channels, length, rate),
    decodeAudioData: async () => makeBuffer(1, sampleRate * 2, sampleRate),
    resume: async () => {},
    close: async () => {},
  };
  return ctx;
}

function makeBuffer(channels, length, rate) {
  const data = new Float32Array(length);
  return {
    numberOfChannels: channels,
    length,
    sampleRate: rate,
    duration: length / rate,
    getChannelData: () => data,
  };
}

async function loadedEngine() {
  let ctx = null;
  const engine = new WebAudioPlayEngine({
    createAudioContext: ({ sampleRate }) => {
      ctx = fakeAudioContext(sampleRate);
      return ctx;
    },
    scheduleFrame: () => () => {},
  });
  await engine.load(PLAYABLE_STEMS.map((name) => ({ name, bytes: new ArrayBuffer(8) })));
  return { engine, ctx: () => ctx };
}

test('getSnapshot returns the SAME object while nothing has changed', async () => {
  const { engine } = await loadedEngine();
  const a = engine.getSnapshot();
  const b = engine.getSnapshot();
  assert.equal(a, b, 'a fresh object per read is what loops a React store binding');
  engine.dispose();
});

test('getSnapshot keeps identity across repeated reads while playing and paused', async () => {
  const { engine, ctx } = await loadedEngine();
  engine.play();
  const playing = engine.getSnapshot();
  assert.equal(engine.getSnapshot(), playing, 'identity broke mid-playback with a frozen clock');
  // The clock is the only thing that has moved: a real position change MUST
  // produce a new object, or the playhead would freeze.
  ctx().currentTime += 1;
  const later = engine.getSnapshot();
  assert.notEqual(later, playing, 'the clock moved a second but the snapshot did not change');
  assert.ok(later.positionSec > playing.positionSec);
  engine.pause();
  const paused = engine.getSnapshot();
  assert.equal(engine.getSnapshot(), paused);
  engine.dispose();
});

test('a mix change produces a new snapshot; a no-op change does not', async () => {
  const { engine } = await loadedEngine();
  const before = engine.getSnapshot();
  engine.setGain('bass', 0.5);
  const after = engine.getSnapshot();
  assert.notEqual(after, before);
  // Setting the same value again is a no-op in the engine, so the UI must not
  // be handed a new object for it.
  engine.setGain('bass', 0.5);
  assert.equal(engine.getSnapshot(), after);
  engine.dispose();
});

test('the loader-to-engine handoff survives a readonly sources array', async () => {
  // `LoadedStems.sources` is `readonly StemSource[]`; `PlayEngine.load` takes a
  // mutable `StemSource[]`. Player copies with a spread — the seam failed to
  // compile once on exactly this mismatch, so this pins the runtime half.
  const { engine } = await loadedEngine();
  const sources = Object.freeze(
    PLAYABLE_STEMS.map((name) => Object.freeze({ name, bytes: new ArrayBuffer(8) })),
  );
  await engine.load([...sources]);
  const snap = engine.getSnapshot();
  assert.equal(snap.status, 'ready');
  assert.equal(snap.degraded, null, 'all six stems were supplied, so nothing is degraded');
  assert.equal(snap.stems.length, PLAYABLE_STEMS.length);
  engine.dispose();
});

test('a partial load reports exactly the missing stems, which is what Story 5.1 renders', async () => {
  const { engine } = await loadedEngine();
  await engine.load([
    { name: 'drums', bytes: new ArrayBuffer(8) },
    { name: 'bass', bytes: new ArrayBuffer(8) },
  ]);
  const snap = engine.getSnapshot();
  assert.deepEqual([...(snap.degraded?.missing ?? [])], ['guitar', 'keys', 'vocals', 'other']);
  assert.match(degradedMessage(snap.degraded.missing), /^Guitar, Keys, Vocals and Other are not available/);
  engine.dispose();
});
