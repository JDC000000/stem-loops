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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { codeOnly, withoutComments } from './helpers/code-only.mjs';

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

// load-stems: the REAL module (it does no I/O at import time; `loadStems` is
// never called in a server render). It used to be a stub, which stopped being
// possible when Player began importing `zeroSourceReason` from it: a stub of a
// pure classifier would test the stub.
const loadStemsMod = put(
  'load-stems.mjs',
  toJs(read('src/lib/play/load-stems.ts')).replace(/from ['"]\.\/types\.ts['"]/g, `from '${typesMod}'`),
);

// report-failure stub: records what Player WOULD send to Sentry, sends nothing.
const reportMod = put(
  'report-failure.mjs',
  `export function reportStemFetchFailure(reason, summary) {
     (globalThis.__stemFetchReports ??= []).push({ reason, summary });
   }`,
);

const engineMod = put(
  'engine.mjs',
  toJs(read('src/lib/play/engine.ts')).replace(/from ['"]\.\/types\.ts['"]/g, `from '${typesMod}'`),
);

const playerJs = rewriteShared(toJs(read('src/components/play/Player.tsx'), true))
  .replace(/from ['"]@\/components\/ChordOverlay['"]/g, `from '${chordMod}'`)
  .replace(/from ['"]@\/lib\/play\/engine['"]/g, `from '${engineMod}'`)
  .replace(/from ['"]@\/lib\/play\/load-stems['"]/g, `from '${loadStemsMod}'`)
  .replace(/from ['"]@\/lib\/play\/report-failure['"]/g, `from '${reportMod}'`)
  .replace(/from ['"]\.\/Mixer['"]/g, `from '${mixerMod}'`)
  .replace(/from ['"]\.\/Transport['"]/g, `from '${transportMod}'`)
  .replace(/from ['"]\.\/SectionLoop['"]/g, `from '${sectionLoopMod}'`);
writeFileSync(join(dir, 'Player.mjs'), playerJs);

// A second Player instance whose Mixer is a RECORDING STUB. The real Mixer
// reads `jobId` only inside effects (sessionStorage restore/persist via
// mixerMemoryKey), so it renders nothing derived from it and no amount of
// server-rendering the real component can see whether the prop arrived. Round 3
// exploited exactly that: `jobId` dropped from the live mount plus a
// `<span data-prev={'<Mixer … jobId={jobId} />'} />` string literal satisfied
// the source-text gate with per-job memory dead. Reflecting the prop into
// markup makes it observable, and a string literal cannot reach markup.
const mixerProbeMod = put(
  'MixerProbe.mjs',
  `import { createElement } from 'react';
   export default function Mixer(props) {
     return createElement('section', {
       'aria-label': 'Stem mixer',
       'data-testid': 'mixer-probe',
       'data-job-id': String(props.jobId),
       'data-has-job-id': String(Object.prototype.hasOwnProperty.call(props, 'jobId')),
     });
   }`,
);
writeFileSync(
  join(dir, 'PlayerMixerProbe.mjs'),
  playerJs.replace(new RegExp(`from '\\./${mixerMod.slice(2)}'`, 'g'), `from '${mixerProbeMod}'`),
);

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const Player = await import(pathToFileURL(join(dir, 'Player.mjs')).href);
const PlayerProbe = await import(pathToFileURL(join(dir, 'PlayerMixerProbe.mjs')).href);
const Loader = await import(pathToFileURL(join(dir, 'load-stems.mjs')).href);

const render = (props) =>
  renderToStaticMarkup(React.createElement(Player.default, { jobId: 'job-1', ...props }));

const {
  UNSUPPORTED_BROWSER_MESSAGE,
  UNDECODABLE_MESSAGE,
  NO_STEMS_MESSAGE,
  ENCODE_FAILED_MESSAGE,
  FETCH_NETWORK_MESSAGE,
  FETCH_HTTP_MESSAGE,
  FETCH_BODY_MESSAGE,
  MANIFEST_UNREACHABLE_MESSAGE,
  zeroSourceNotice,
  GENERIC_LOAD_MESSAGE,
  PlayerView,
  chordPositionFor,
  degradedMessage,
  hasWebAudio,
  isPlayable,
  stemLoadMessage,
} = Player;

const noop = () => {};

/** What the component holds before any engine exists. */
const IDLE = Object.freeze({
  status: 'idle',
  positionSec: 0,
  durationSec: 0,
  stems: [],
  loop: null,
  degraded: null,
  error: null,
});

/**
 * Render the view directly with a phase and a snapshot. `Player` itself only
 * leaves the `idle` phase from an effect, and `renderToStaticMarkup` never runs
 * effects, so every phase below is unreachable through `Player` in node. This
 * is what makes them assertable instead of grep-able.
 */
const renderView = (props) =>
  renderToStaticMarkup(
    React.createElement(PlayerView, {
      jobId: 'job-1',
      sections: [],
      onPlay: noop,
      onPause: noop,
      onSeek: noop,
      onGain: noop,
      onMute: noop,
      onSolo: noop,
      onLoop: noop,
      ...props,
    }),
  );

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

// ═══ Story 3.3 — a NUMBER must arrive, not just a prop ══════════════════════
//
// Review set `const chordPosition = null;` and all 939 tests stayed green: the
// earlier tests proved the prop was WRITTEN, never that a position ARRIVED.
// These drive a real engine and assert on the value the overlay is handed.

const positionOf = (html) => {
  const raw = attr(html, 'data-position');
  return raw === null || raw === 'null' ? null : Number(raw);
};

test('a playing engine hands the chord track a real, non-null number', async () => {
  const { engine, ctx } = await loadedEngine();
  engine.play();
  ctx().currentTime += 1.5;
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.status, 'playing');

  const html = renderView({ phase: { kind: 'ready' }, snapshot });
  const pos = positionOf(html);
  assert.notEqual(pos, null, 'the chord playhead was handed null while the engine was playing');
  assert.ok(Number.isFinite(pos), `expected a finite position, got ${pos}`);
  assert.ok(pos > 0, `expected the position to have advanced, got ${pos}`);
  engine.dispose();
});

test('the number the chord track gets ADVANCES as the engine clock advances', async () => {
  const { engine, ctx } = await loadedEngine();
  engine.play();
  ctx().currentTime += 0.5;
  const first = positionOf(renderView({ phase: { kind: 'ready' }, snapshot: engine.getSnapshot() }));
  ctx().currentTime += 1;
  const second = positionOf(renderView({ phase: { kind: 'ready' }, snapshot: engine.getSnapshot() }));
  assert.ok(first !== null && second !== null, 'the playhead went null mid-playback');
  assert.ok(second > first, `the playhead did not move: ${first} -> ${second}`);
  // The clock moved a second, so the marker must have moved about a second.
  assert.ok(Math.abs(second - first - 1) < 0.05, `expected ~1 s of travel, got ${second - first}`);
  engine.dispose();
});

test('a loaded engine paused at the top passes 0, NOT null', async () => {
  // `null` means "not playable" and blanks the marker. A ready engine sitting
  // at 0 is playable, so the marker belongs on the first chord.
  const { engine } = await loadedEngine();
  const html = renderView({ phase: { kind: 'ready' }, snapshot: engine.getSnapshot() });
  assert.equal(positionOf(html), 0);
  assert.equal(attr(html, 'data-has-position'), 'true');
  engine.dispose();
});

test('chordPositionFor: every non-playable state blanks the marker', async () => {
  const { engine, ctx } = await loadedEngine();
  engine.play();
  ctx().currentTime += 1;
  const playing = engine.getSnapshot();
  assert.ok(chordPositionFor({ kind: 'ready' }, playing) > 0);
  for (const phase of [
    { kind: 'idle' },
    { kind: 'loading' },
    { kind: 'no-stems' },
    { kind: 'unsupported', message: 'x' },
    { kind: 'load-error', message: 'x' },
  ]) {
    assert.equal(chordPositionFor(phase, playing), null, `${phase.kind} should blank the marker`);
  }
  // An engine that errored is not playable either, even in the ready phase.
  const errored = { ...playing, error: { code: 'PLAY_DECODE_FAILED', message: 'x' } };
  assert.equal(chordPositionFor({ kind: 'ready' }, errored), null);
  engine.dispose();
});

// ═══ Story 6.4 — the no-stems fallback actually renders ═════════════════════

test('phase "no-stems" renders the fallback note and NO transport', async () => {
  const html = renderView({ phase: { kind: 'no-stems' }, snapshot: IDLE });
  assert.equal(attr(html, 'data-phase'), 'no-stems');
  assert.match(html, /data-testid="player-banner"/);
  assert.ok(html.includes(NO_STEMS_MESSAGE), 'the fallback note is missing');
  // Story 6.4 is explicitly NOT a failure, so this banner is a polite status,
  // never an alert. Inverting the two roles used to survive the whole suite.
  assert.match(html, /role="status"/, 'the no-stems fallback must not be an alert');
  assert.doesNotMatch(html, /role="alert"/, 'the fallback is being announced as a failure');
  // A transport here would be a dead control over audio that does not exist.
  assert.doesNotMatch(html, /data-testid="transport"/);
  assert.doesNotMatch(html, /aria-label="Stem mixer"/);
  // The chord track survives the fallback — that is the rest of Story 6.4.
  assert.match(html, /data-testid="chord-overlay"/);
  assert.equal(positionOf(html), null);
});

// ═══ Story 1.4 — ready + engine error is REACHABLE, and must not be playable ══

test('phase "ready" WITH an engine error renders the banner and NO transport', async () => {
  // The gap review found. `engine.load()` reports TOO_LONG / DECODE_FAILED /
  // NO_STEMS / NO_AUDIO by calling `fail()` and RETURNING, not throwing, so
  // Player reaches `phase = 'ready'` with `snapshot.error` set. This is the one
  // such state actually reachable through load(), and it was the only one not
  // pinned: `no-stems` and `unsupported` were, so dropping the error guard from
  // `playable` passed all 958 tests while putting a full Transport + Mixer +
  // SectionLoop over an engine with zero buffers and durationSec 0.
  const snapshot = Object.freeze({
    ...IDLE,
    status: 'error',
    error: { code: 'PLAY_TRACK_TOO_LONG', message: 'Track is 420.0 s; the limit is 300 s.' },
  });
  const html = renderView({ phase: { kind: 'ready' }, snapshot });

  assert.match(html, /data-testid="player-banner"/, 'the engine error is not surfaced');
  assert.ok(html.includes('the limit is 300 s'), "the banner must name the engine's own reason");
  // An engine error is an ALERT, not a status note: a screen reader must be
  // interrupted by it. Nothing asserted any role/aria on these banners before,
  // so inverting error and notice was a silent, assistive-tech-only change.
  assert.match(html, /role="alert"/, 'an engine error must be announced as an alert');
  // Every control the `playable` gate owns. A transport here is a dead button.
  assert.doesNotMatch(html, /data-testid="transport"/, 'a dead transport over a failed engine');
  assert.doesNotMatch(html, /aria-label="Stem mixer"/, 'a dead mixer over a failed engine');
  assert.doesNotMatch(html, /aria-label="Loop a section"/, 'dead loop chips over a failed engine');
  // The other half of the contract, already pinned, restated here so the two
  // halves live together.
  assert.equal(positionOf(html), null, 'the chord marker must not run on a failed engine');
  // The chord track itself stays, as in every non-playable phase.
  assert.match(html, /data-testid="chord-overlay"/);
});

test('isPlayable and chordPositionFor agree on every phase/error combination', () => {
  // The structural fix for the above: one predicate, two call sites. If they
  // are ever re-stated separately, this fails before the render tests do.
  const phases = [
    { kind: 'idle' },
    { kind: 'loading' },
    { kind: 'no-stems' },
    { kind: 'ready' },
    { kind: 'load-error', message: 'x' },
    { kind: 'unsupported', message: 'x' },
  ];
  const errors = [null, { code: 'PLAY_TRACK_TOO_LONG', message: 'too long' }];
  for (const phase of phases) {
    for (const error of errors) {
      const snapshot = Object.freeze({ ...IDLE, positionSec: 1.5, error });
      const playable = isPlayable(phase, snapshot);
      const position = chordPositionFor(phase, snapshot);
      assert.equal(
        playable,
        position !== null,
        `isPlayable=${playable} but chordPositionFor=${position} for phase ${phase.kind}, error ${error ? error.code : 'none'}`,
      );
      assert.equal(playable, phase.kind === 'ready' && error === null);
    }
  }
});

test('phase "unsupported" renders the browser banner and no transport', async () => {
  const html = renderView({
    phase: { kind: 'unsupported', message: UNSUPPORTED_BROWSER_MESSAGE },
    snapshot: IDLE,
  });
  assert.equal(attr(html, 'data-phase'), 'unsupported');
  assert.ok(html.includes(UNSUPPORTED_BROWSER_MESSAGE));
  assert.doesNotMatch(html, /data-testid="transport"/);
  assert.match(html, /data-testid="chord-overlay"/);
});

// ═══ Story 5.1 — the degraded banner actually renders ═══════════════════════

test('a degraded snapshot renders a banner NAMING the missing stems', async () => {
  const { engine } = await loadedEngine();
  await engine.load([
    { name: 'drums', bytes: new ArrayBuffer(8) },
    { name: 'bass', bytes: new ArrayBuffer(8) },
  ]);
  const snapshot = engine.getSnapshot();
  const html = renderView({ phase: { kind: 'ready' }, snapshot });
  assert.match(html, /data-testid="player-degraded"/, 'no degraded banner for a partial load');
  for (const name of ['Guitar', 'Keys', 'Vocals', 'Other']) {
    assert.ok(html.includes(name), `the banner does not name ${name}`);
  }
  // Story 5.1's other half: the rest still plays, so the transport stays.
  assert.match(html, /data-testid="transport"/);
  engine.dispose();
});

test('a complete snapshot renders NO degraded banner', async () => {
  const { engine } = await loadedEngine();
  const html = renderView({ phase: { kind: 'ready' }, snapshot: engine.getSnapshot() });
  assert.doesNotMatch(html, /data-testid="player-degraded"/);
  engine.dispose();
});

// ═══ Story 2.7 / 1.2 — the two mounts that carry the story ══════════════════

/**
 * `codeOnly` now lives in test/helpers/code-only.mjs and is a single-pass
 * scanner rather than a stack of `.replace()` calls. The regex stack that used
 * to live here was broken in BOTH directions by round 3:
 *   - a STRING literal containing the pattern satisfied a `match` gate
 *     (`<span title={'<Player jobId={job.id} … />'} />` passed both mount gates
 *     with the real mount deleted);
 *   - a `//` inside a string deleted real code, so a `doesNotMatch` gate
 *     passed blind.
 * Reordering the rules only moves the hole — the helper's own comment shows
 * both orderings losing real code on mirror-image inputs.
 *
 * These source-text gates are the SECONDARY layer. The primary answer for the
 * mounts is test/job-page-render.test.mjs, which asserts on RENDERED OUTPUT: a
 * string literal cannot put a mounted component into rendered HTML. What is
 * kept here is what rendering cannot see — a commented-out mount, and a
 * trailing `//` that fakes render order.
 */

test('Story 2.7: the Mixer mount carries jobId, which is its memory key', () => {
  // The Mixer keys sessionStorage on `jobId` (mixerMemoryKey). Drop the prop
  // and the component is purely props-driven: faders silently stop being
  // remembered, with nothing else observable changing.
  //
  // codeOnly, and that is not incidental: read raw, this assertion was a false
  // green. Dropping jobId from the live mount and leaving a plausible
  // commented-out `{/* was: <Mixer … jobId={jobId} /> */}` above it passed the
  // whole suite with per-job memory dead.
  const src = codeOnly(read('src/components/play/Player.tsx'));
  assert.match(
    src,
    /<Mixer[^>]*\bjobId=\{jobId\}/,
    'the Mixer lost jobId, so Story 2.7 memory is dead',
  );
});

test('FG-3: Story 2.7 observed in RENDERED output, not in source text', () => {
  // The round-3 false green this closes: `jobId` dropped from the live <Mixer>
  // mount, with `<span data-prev={'<Mixer … jobId={jobId} />'} />` added to keep
  // the source-text gate above green. 961/941/0/20, typecheck 0, lint 0, and
  // per-job fader/mute/solo memory silently dead.
  //
  // Here the Mixer is a recording stub that reflects the prop into its markup,
  // and the view is driven into `ready` so the mixer actually mounts. A string
  // literal in the source cannot put `data-job-id` into rendered HTML.
  const snapshot = Object.freeze({
    ...IDLE,
    status: 'paused',
    durationSec: 30,
    stems: PLAYABLE_STEMS.map((stem) => ({ stem, gain: 1, muted: false, solo: false })),
  });
  const html = renderToStaticMarkup(
    React.createElement(PlayerProbe.PlayerView, {
      jobId: 'job-probe-7',
      sections: [],
      phase: { kind: 'ready' },
      snapshot,
      onPlay: noop,
      onPause: noop,
      onSeek: noop,
      onGain: noop,
      onMute: noop,
      onSolo: noop,
      onLoop: noop,
    }),
  );
  assert.match(html, /data-testid="mixer-probe"/, 'the Mixer did not mount in the ready phase');
  assert.equal(
    html.match(/data-testid="mixer-probe"[^>]*data-has-job-id="([^"]*)"/)?.[1],
    'true',
    'the <Mixer> mount does not pass jobId at all, so Story 2.7 memory is dead',
  );
  assert.equal(
    html.match(/data-testid="mixer-probe"[^>]*data-job-id="([^"]*)"/)?.[1],
    'job-probe-7',
    'the <Mixer> mount passes the wrong jobId, so memory keys the wrong job',
  );
});

test('codeOnly blanks comments AND literals, in both directions', () => {
  // The helper is load-bearing for three Story gates, so it is pinned directly
  // rather than only through them. Round 2's cases first.
  assert.match(codeOnly('  // gone\nkept();'), /kept\(\)/);
  assert.doesNotMatch(codeOnly('  // gone\nkept();'), /gone/);
  assert.match(codeOnly('kept(); // gone'), /kept\(\)/);
  assert.doesNotMatch(codeOnly('kept(); // gone'), /gone/);
  assert.match(codeOnly('/* gone\n gone */kept();'), /kept\(\)/);
  assert.doesNotMatch(codeOnly('/* gone\n gone */kept();'), /gone/);
  assert.doesNotMatch(codeOnly('const a = 1; // <Player'), /<Player/);
  assert.doesNotMatch(codeOnly('{/* <Mixer jobId={jobId} /> */}'), /<Mixer/);
  // A line comment must not be able to open a block that eats real code.
  assert.match(codeOnly('// /* not a comment\nkept();'), /kept\(\)/);

  // ── round 3, UNDER-inclusive: a literal must not satisfy a `match` gate ──
  assert.doesNotMatch(
    codeOnly(`<span title={'<Player jobId={job.id} enabled />'} />`),
    /<Player/,
    'a string literal can still satisfy the mount gate',
  );
  assert.doesNotMatch(
    codeOnly(`<span data-prev={'<Mixer stems={s} jobId={jobId} />'} />`),
    /<Mixer/,
    'a string literal can still satisfy Story 2.7',
  );
  assert.doesNotMatch(codeOnly('const t = `<Player jobId={x}`;'), /<Player/);
  assert.doesNotMatch(codeOnly('const r = /<Player jobId=/;'), /<Player/);

  // ── round 3, OVER-inclusive: a `//` in a string must not delete code ────
  assert.match(
    codeOnly('<section aria-label="chords//legacy"><ChordOverlay jobId={j} /></section>'),
    /<ChordOverlay/,
    'a `//` inside an attribute string still blinds the doesNotMatch gates',
  );
  // Both rule orderings of the old regex stack lost real code on one of these.
  assert.match(codeOnly('const P = 1; // see /* the note\nREAL_A();\n/* r */\n'), /REAL_A/);
  assert.match(codeOnly('/* note // end */ REAL_B();\n'), /REAL_B/);
  assert.match(codeOnly(`const s = "a // b";\nREAL_C();`), /REAL_C/);
  // A URL no longer leaks out of its string, but the statement around it must
  // survive — that was the real point of the old `spares URLs` assertion.
  const url = codeOnly(`const u = 'https://x.example/a';\nREAL_D();`);
  assert.match(url, /const u =/);
  assert.match(url, /REAL_D/);

  // Length and newlines are preserved, so indexOf ordering keeps its meaning.
  const sample = `a//b\n'c'\n/*d*/e`;
  assert.equal(codeOnly(sample).length, sample.length);
  assert.equal(codeOnly(sample).split('\n').length, sample.split('\n').length);
});

test('withoutComments keeps literals readable but still removes comments', () => {
  // The gutter gate reads a string literal's VALUE, so it needs this variant.
  // It must still be right about comments, which is the whole defect.
  const src = `const wrap = { padding: '48px var(--sl-gutter, 16px) 96px' }; // note`;
  const out = withoutComments(src);
  assert.match(out, /var\(--sl-gutter, 16px\)/, 'the literal became unreadable');
  assert.doesNotMatch(out, /note/, 'the trailing comment survived');
  // A `//` inside a string is not a comment, so it must not eat what follows.
  assert.match(withoutComments(`const s = "a // b";\nREAL();`), /REAL\(\)/);
  // And a `/*` inside a line comment must not open a block.
  assert.match(withoutComments('// /* not a comment\nREAL2();'), /REAL2\(\)/);
});

test('Story 1.2: the Player is mounted ABOVE LoopResults on the job page', () => {
  // "Everybody uploading songs wants to see the player and toggle and play
  // along" — the player is the primary view and the loop downloader is
  // secondary. Swapping the two is invisible to every other test.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is not incidental: the first version
  // of this test used indexOf on the raw source and SURVIVED the swap, because
  // JobView's header comment names `<Player>` before `<LoopResults>` in prose.
  // It was measuring the documentation's word order, not the render order.
  const view = codeOnly(read('src/app/jobs/[id]/JobView.tsx'));
  const player = view.indexOf('<Player');
  const loops = view.indexOf('<LoopResults');
  assert.ok(player !== -1, 'JobView no longer mounts the Player at all');
  assert.ok(loops !== -1, 'JobView no longer mounts LoopResults');
  assert.ok(player < loops, 'LoopResults is above the Player — Story 1.2 is inverted');
});

// ═══ the page gutter the mixer budgeted against ═════════════════════════════

test('the job page gutter is the token with a 16px fallback, never a literal', () => {
  // Cross-PR defect (#197 + #194). The mixer's 360px layout budget assumes the
  // app's 16px gutter. This page hard-coded 24px inline, which at 360px drove
  // channels to exactly 46.00px and truncated "VOCALS" to "VOCA…" — the defect
  // #194's 5c3c181 exists to prevent. A literal here cannot be seen by either
  // side's tests, so the literal is what this pins.
  //
  // Scoped to the `wrap` object rather than the file's FIRST `padding:`. There
  // is a second padding declaration further down (the failed-job box), so the
  // unscoped form depended purely on declaration order: reordering the two
  // would have pointed this assertion at the wrong rule.
  // `withoutComments`, not `codeOnly`: this gate INSPECTS a string literal's
  // value, so blanking literals would leave it unable to see the thing it
  // exists to check. Comments are still removed, and correctly — a `//` inside
  // a string no longer eats the rest of the line.
  const view = withoutComments(read('src/app/jobs/[id]/JobView.tsx'));
  const wrap = view.match(/const wrap:[^=]*=\s*\{[\s\S]*?\n\s*\};/)?.[0];
  assert.ok(wrap, 'the page wrapper style object moved or was renamed');
  const padding = wrap.match(/padding:\s*'([^']+)'/)?.[1];
  assert.ok(padding, 'the page wrapper lost its padding declaration');
  assert.match(padding, /var\(--sl-gutter,\s*16px\)/, `gutter is not the token: ${padding}`);
  assert.doesNotMatch(
    padding,
    /\d+px\s+\d+px\s+\d+px/,
    `a hard-coded three-value gutter is back: ${padding}`,
  );
});

// Length-preserving CSS comment blanker, same contract as the scanner in
// helpers/code-only.mjs: offsets and line numbers keep meaning what they say.
// A gate that reads a STYLESHEET's text has the same comment-blind hole a JS
// gate has, and here it is not hypothetical — design-tokens.css's own prose
// names `--sl-gutter` twice, within a few lines of the declaration, and one of
// those lines is the explanation of this very move. Matching raw CSS would let
// the comment satisfy the gate after the declaration had gone.
function cssCodeOnly(src) {
  const out = Array.from(src);
  for (let i = 0; i < src.length - 1; i += 1) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let k = i; k < stop; k += 1) if (out[k] !== '\n') out[k] = ' ';
      i = stop - 1;
    }
  }
  return out.join('');
}

test('the gutter token is in scope on this route, because the root layout imports it', () => {
  // THIS GATE IS THE INVERSE OF THE ONE IT REPLACES, and the inversion is the
  // point. Until #199 `--sl-gutter` lived in src/styles/landing.css, imported
  // only by app/(landing)/layout.tsx and app/not-found.tsx; /jobs/[id] is not
  // in that group, so the token was NOT in scope here and the `16px` fallback
  // in JobView's padding was the only thing rendering. The old test pinned
  // that — `landing.css` still declares 16px — and said in its own comment:
  // "If this route is ever brought into landing.css's scope, delete this test."
  //
  // #199 did something better than bring the route into landing.css's scope:
  // it moved the token OUT of landing.css into design-tokens.css, which
  // globals.css imports and the ROOT layout imports, so it now resolves
  // identically on every route. The old premise is false by design, and the
  // assertion fired as soon as #197 and #199 were in the same tree.
  //
  // DELETING THE TEST WOULD HAVE BEEN A FALSE GREEN. The property worth
  // guarding did not vanish, it changed sides: it used to be "the fallback is
  // load-bearing because the token is out of scope", and it is now "the token
  // is in scope globally, so `var(--sl-gutter)` resolves on every route". So
  // this asserts the LIVE IMPORT CHAIN and fails if anyone un-globals the
  // token — by deleting the declaration, by dropping globals.css's @import, or
  // by dropping the root layout's import of globals.css. Any of the three puts
  // /jobs/[id] back on a 16px literal at every width WITHOUT changing JobView,
  // which is exactly the kind of cross-file drift that produced this bug.
  //
  // The 16px FALLBACK stays, and the sibling test above still pins it: it is
  // what renders if this chain is ever broken, and a bare `var(--sl-gutter)`
  // would take the whole padding shorthand — the 48px top and 96px bottom with
  // it — down to 0 rather than degrade.
  //
  // Each link is RESOLVED ON DISK rather than string-matched, so renaming or
  // moving any of the three files fails this instead of silently passing.
  // Note what this does NOT claim: that the token has a particular VALUE at a
  // particular width. play-mixer.test.mjs owns that (`pageGutter()`), along
  // with the invariant that exactly one file declares it.
  const tokensRel = 'src/styles/design-tokens.css';
  const globalsRel = 'src/app/globals.css';
  const layoutRel = 'src/app/layout.tsx';

  for (const rel of [tokensRel, globalsRel, layoutRel]) {
    assert.ok(existsSync(join(WEB, rel)), `${rel} is gone — the scope chain names a file that is not there`);
  }

  // ── link 1: design-tokens.css DECLARES the token ───────────────────────────
  const tokens = cssCodeOnly(read(tokensRel));
  assert.match(
    tokens,
    /--sl-gutter\s*:\s*\S/,
    `${tokensRel} no longer declares --sl-gutter; /jobs/[id] is back on the literal`,
  );

  // ── link 2: globals.css @imports design-tokens.css ─────────────────────────
  const globals = cssCodeOnly(read(globalsRel));
  const cssImports = [...globals.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(
    cssImports.some((spec) => resolve(dirname(join(WEB, globalsRel)), spec) === join(WEB, tokensRel)),
    `${globalsRel} no longer @imports ${tokensRel} — it imports ${JSON.stringify(cssImports)}`,
  );

  // ── link 3: the ROOT layout imports globals.css ────────────────────────────
  // `withoutComments` to READ the specifier (it is a string literal, which
  // `codeOnly` would blank), then `codeOnly` at the SAME offset to prove the
  // match is a real import statement and not a decoy inside another string:
  // `const s = "import './globals.css';"` reads as `import …` to the first
  // scanner and as spaces to the second. Both preserve length, so the offset
  // means the same thing in each.
  const layoutSrc = read(layoutRel);
  const layoutText = withoutComments(layoutSrc);
  const layoutCode = codeOnly(layoutSrc);
  const sideEffectImports = [...layoutText.matchAll(/import\s+['"]([^'"]+)['"]/g)]
    .filter((m) => layoutCode.startsWith('import', m.index))
    .map((m) => m[1]);
  assert.ok(
    sideEffectImports.some((spec) => resolve(dirname(join(WEB, layoutRel)), spec) === join(WEB, globalsRel)),
    `the root layout no longer imports ${globalsRel} — it side-effect imports ${JSON.stringify(sideEffectImports)}`,
  );
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

// ═══ first-run honesty: the sentence matches what happened ═══════════════════
// The defect: a fresh job whose encoder FAILED, a browser that could not reach
// storage, and a legacy job with nothing stored all rendered "it was processed
// before play-along audio was kept". These drive the REAL loader with a fake
// fetch, through the same two pure functions the effect calls, and assert the
// words a user would read.

const JOB_ID = '11111111-2222-3333-4444-555555555555';
const mjson = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const six = ['vocals', 'drums', 'bass', 'other', 'guitar', 'keys'];
const offered = six.map((s) => ({ stem: s, signed_url: `https://acct.r2.example/${s}.opus?X-Amz-Signature=zzz` }));
async function noticeFor({ manifest, stem }) {
  const out = await Loader.loadStems(JOB_ID, {
    fetch: async (url) => (String(url).startsWith('/api/') ? mjson(manifest) : stem(url)),
  });
  return { out, reason: Loader.zeroSourceReason(out), notice: zeroSourceNotice(Loader.zeroSourceReason(out)) };
}

test('a fresh job whose encoder failed does NOT get the "processed before" sentence', async () => {
  const { reason, notice } = await noticeFor({ manifest: { stems: [], state: 'encode_failed' } });
  assert.equal(reason, 'ENCODE_FAILED');
  assert.equal(notice.message, ENCODE_FAILED_MESSAGE);
  assert.equal(notice.retryable, false, 'a reload does not re-encode: do not offer it as the cure');
  assert.doesNotMatch(notice.message, /processed before|aged|old|24 hours|no longer/i);
  assert.match(notice.message, /could not prepare/i);
});

test('a browser that cannot reach storage (CORS-shaped) gets a network sentence, retryable', async () => {
  const { reason, notice } = await noticeFor({
    manifest: { stems: offered, state: 'ready' },
    stem: () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(reason, 'FETCH_NETWORK');
  assert.equal(notice.message, FETCH_NETWORK_MESSAGE);
  assert.equal(notice.retryable, true);
  assert.doesNotMatch(notice.message, /processed before/i);
});

test('a legacy job (nothing stored) is the one that keeps the calm fallback, and it asserts no cause', async () => {
  const { reason, notice } = await noticeFor({ manifest: { stems: [], state: 'unavailable' } });
  assert.equal(reason, 'NO_STEMS');
  assert.equal(notice, null, 'null = the Story 6.4 note, not an error');
  assert.doesNotMatch(NO_STEMS_MESSAGE, /processed before|aged|expired|old /i);
});

test('the five outcomes read as five different sentences', () => {
  const msgs = [
    zeroSourceNotice('ENCODE_FAILED').message,
    zeroSourceNotice('FETCH_NETWORK').message,
    zeroSourceNotice('FETCH_HTTP').message,
    zeroSourceNotice('FETCH_BODY').message,
    NO_STEMS_MESSAGE,
  ];
  assert.equal(new Set(msgs).size, 5);
  assert.equal(zeroSourceNotice('NO_STEMS'), null);
  assert.equal(zeroSourceNotice('PLAYABLE'), null);
  assert.ok(FETCH_HTTP_MESSAGE && FETCH_BODY_MESSAGE);
});

test('a failed manifest request says the SERVER was unreachable, not that audio is missing', () => {
  assert.equal(stemLoadMessage('MANIFEST_FAILED'), MANIFEST_UNREACHABLE_MESSAGE);
  assert.notEqual(stemLoadMessage('MANIFEST_FAILED'), GENERIC_LOAD_MESSAGE);
});

test('load-error renders as an ALERT; "Try again" appears only when the failure is retryable', () => {
  const retry = renderView({
    phase: { kind: 'load-error', message: FETCH_NETWORK_MESSAGE, retryable: true },
    snapshot: IDLE,
    onRetry: noop,
  });
  assert.match(retry, /role="alert"/);
  assert.ok(retry.includes(FETCH_NETWORK_MESSAGE));
  assert.match(retry, /data-testid="player-retry"/);
  assert.match(retry, />Try again</);

  const noRetry = renderView({
    phase: { kind: 'load-error', message: ENCODE_FAILED_MESSAGE, retryable: false },
    snapshot: IDLE,
    onRetry: noop,
  });
  assert.match(noRetry, /role="alert"/);
  assert.doesNotMatch(noRetry, /player-retry/);

  // not offered over the calm fallback either
  const calm = renderView({ phase: { kind: 'no-stems' }, snapshot: IDLE, onRetry: noop });
  assert.doesNotMatch(calm, /player-retry/);
  // retryable but no handler wired: no dead button
  const dead = renderView({ phase: { kind: 'load-error', message: 'x', retryable: true }, snapshot: IDLE });
  assert.doesNotMatch(dead, /player-retry/);
  // the chord track survives every one of them
  assert.match(retry, /data-testid="chord-overlay"/);
});

test('Player wires the three outcomes: it reads zeroSourceReason and reports only the browser-side ones', () => {
  const src = codeOnly(read('src/components/play/Player.tsx'));
  assert.match(src, /zeroSourceReason\(loaded\)/);
  assert.match(src, /reportStemFetchFailure\(reason, loaded\.stemFailures\)/);
  // ENCODE_FAILED must never reach the reporter (worker reports it once per job;
  // a refetch by anyone holding the UUID would otherwise mint events)
  assert.doesNotMatch(src, /reportStemFetchFailure\([^)]*ENCODE/);
});
