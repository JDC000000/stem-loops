// Mixer (Story 2): six vertical faders, mute, solo, and the Story 5 "a stem is
// missing and we say so" case.
//
// HARNESS. There is no jsdom in this repo and node's --experimental-strip-types
// loader does not accept `.tsx`, so this follows the pattern already set by
// test/helpers/render-login-form.mjs: transpile the component with the
// TypeScript compiler into node_modules/.cache (so bare `react` and
// `react/jsx-runtime` resolve), stub the CSS module with a Proxy that returns
// each class name verbatim, and server-render to static markup.
//
// WHAT THAT COVERS: first paint — element order, roles, every aria attribute,
// disabled derivation, the distinct muted / solo-ducked / unavailable
// treatments — plus every exported pure function, driven directly, including
// the rAF coalescer with an injected scheduler.
//
// WHAT IT CANNOT COVER: real pointer and keyboard events, so "the thumb tracks
// the finger" and "an arrow key moves the fader" are asserted structurally
// (a real `input[type=range]` with step/min/max, which gives arrow keys for
// free) rather than by driving an event loop. Those belong in the Playwright
// e2e, same as ChordOverlay's. See the PR description.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

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

const MIXER_TSX = 'src/components/play/Mixer.tsx';
const MIXER_CSS = 'src/components/play/Mixer.module.css';
// The page gutter the mixer has to live inside is declared here, not in the
// Mixer's own stylesheet, so the width test reads it from here rather than
// restating it. See `pageGutter()` below.
const LANDING_CSS = 'src/styles/landing.css';

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'play-mixer-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

const typesMod = put('play-types.mjs', toJs(read('src/lib/play/types.ts')));
// The CSS module returns each class name unchanged, so markup assertions can
// look for `isMuted` / `isDucked` directly.
const cssMod = put(
  'mixer-styles.mjs',
  'export default new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });',
);

const mixerJs = toJs(read(MIXER_TSX), true)
  .replace(/from ['"]@\/lib\/play\/types['"]/g, `from '${typesMod}'`)
  .replace(/from ['"]\.\/Mixer\.module\.css['"]/g, `from '${cssMod}'`);
writeFileSync(join(dir, 'Mixer.mjs'), mixerJs);

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const Mixer = await import(pathToFileURL(join(dir, 'Mixer.mjs')).href);
const { PLAYABLE_STEMS } = await import(pathToFileURL(join(dir, 'play-types.mjs')).href);

const render = (props) => renderToStaticMarkup(React.createElement(Mixer.default, props));

// ─── fixtures ────────────────────────────────────────────────────────────────

const stem = (name, over = {}) => ({
  name,
  availability: 'ready',
  gain: 0.8,
  muted: false,
  soloed: false,
  effectivelySilent: false,
  ...over,
});

/**
 * The engine's rule, applied the way additive solo actually behaves:
 * silent when muted, or when some OTHER stem is soloed and this one is not.
 * The component never recomputes this — it only renders what it is handed —
 * but fixtures have to be internally consistent to be worth asserting on.
 */
const withSilence = (list) => {
  const anySoloed = list.some((s) => s.soloed);
  return list.map((s) => ({ ...s, effectivelySilent: s.muted || (anySoloed && !s.soloed) }));
};

const allReady = (over = {}) => withSilence(PLAYABLE_STEMS.map((n) => stem(n, over)));

const noop = () => {};
const handlers = () => ({ onGain: noop, onMute: noop, onSolo: noop });

// ─── markup helpers ──────────────────────────────────────────────────────────

const faders = (html) => html.match(/<input[^>]*type="range"[^>]*>/g) ?? [];
const faderFor = (html, name) =>
  faders(html).find((tag) => tag.includes(`id="mixer-fader-${name}"`)) ?? null;
const channelOrder = (html) => [...html.matchAll(/data-stem="([a-z]+)"/g)].map((m) => m[1]);
/** The <div> opening tag of one channel, with its class list. */
const channelTag = (html, name) =>
  html.match(new RegExp(`<div class="[^"]*" data-stem="${name}"[^>]*>`))?.[0] ?? null;
const buttonFor = (html, name, role) =>
  html.match(new RegExp(`<button[^>]*aria-label="${role} ${name}"[^>]*>`))?.[0] ?? null;
const noteFor = (html, name) =>
  html.match(new RegExp(`<p class="[^"]*" id="mixer-note-${name}">([^<]*)</p>`))?.[1] ?? null;
const attr = (tag, key) => tag?.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? null;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ═══ Criterion 1 — six faders, fixed order ═══════════════════════════════════

test('six faders, one per stem, in the fixed PLAYABLE_STEMS order', () => {
  const html = render({ stems: allReady(), ...handlers() });
  assert.equal(faders(html).length, 6);
  assert.deepEqual(channelOrder(html), [...PLAYABLE_STEMS]);
  assert.deepEqual([...PLAYABLE_STEMS], ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other']);
});

test('a reversed snapshot still renders in PLAYABLE_STEMS order', () => {
  const html = render({ stems: [...allReady()].reverse(), ...handlers() });
  assert.deepEqual(channelOrder(html), [...PLAYABLE_STEMS]);
});

test('mixerRows: out-of-order input is re-ordered, not re-labelled', () => {
  const shuffled = [stem('other'), stem('bass'), stem('vocals'), stem('drums'), stem('keys'), stem('guitar')];
  assert.deepEqual(
    Mixer.mixerRows(shuffled).map((r) => r.stem.name),
    [...PLAYABLE_STEMS],
  );
  // the gain stayed with its own stem
  const rows = Mixer.mixerRows([stem('other', { gain: 0.1 }), stem('drums', { gain: 0.9 })]);
  assert.equal(rows[0].stem.gain, 0.9); // drums
  assert.equal(rows[5].stem.gain, 0.1); // other
});

test('mixerRows: an EMPTY snapshot still yields six channels, every one disabled and explained', () => {
  for (const input of [[], null, undefined]) {
    const rows = Mixer.mixerRows(input);
    assert.equal(rows.length, 6, `six rows for ${JSON.stringify(input)}`);
    assert.deepEqual(rows.map((r) => r.stem.name), [...PLAYABLE_STEMS]);
    assert.ok(rows.every((r) => r.disabled));
    assert.ok(rows.every((r) => r.present === false));
    assert.ok(rows.every((r) => /unavailable/i.test(r.unavailableReason)));
  }
});

test('an empty snapshot renders six disabled faders, never six live-looking ones', () => {
  const html = render({ stems: [], ...handlers() });
  assert.equal(faders(html).length, 6);
  assert.equal(faders(html).filter((f) => f.includes('disabled')).length, 6);
  for (const name of PLAYABLE_STEMS) assert.match(noteFor(html, name), /Unavailable/);
});

test('mixerRows: duplicates collapse (first wins) and unknown stem names are dropped', () => {
  const rows = Mixer.mixerRows([
    stem('drums', { gain: 0.25 }),
    stem('drums', { gain: 0.99 }),
    stem('triangle', { gain: 1 }),
    { name: 'kazoo' },
    null,
  ]);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].stem.gain, 0.25, 'the first drums entry won');
  assert.ok(!rows.some((r) => r.stem.name === 'triangle' || r.stem.name === 'kazoo'));
});

// ═══ Criterion 2 — vertical and continuous, 0–100% ═══════════════════════════

test('each fader is a real continuous range input, 0..100 step 1 (not a binary toggle)', () => {
  const html = render({ stems: allReady(), ...handlers() });
  for (const name of PLAYABLE_STEMS) {
    const f = faderFor(html, name);
    assert.ok(f, `${name} fader`);
    assert.equal(attr(f, 'min'), '0');
    assert.equal(attr(f, 'max'), '100');
    assert.equal(attr(f, 'step'), '1');
    assert.equal(attr(f, 'type'), 'range');
  }
});

test('faders are vertical: orient attribute present, and the stylesheet sets writing-mode', () => {
  const html = render({ stems: allReady(), ...handlers() });
  assert.equal(faders(html).filter((f) => f.includes('orient="vertical"')).length, 6);
  // EFFECTIVE css, scoped to the `.fader` rule. This block used to assert
  // `-webkit-appearance: slider-vertical` against RAW text, and was satisfied
  // by a comment explaining that `slider-vertical` had been deliberately
  // removed. `slider-vertical` is a NATIVE widget: declared on a range input
  // it stops `::-webkit-slider-thumb` taking author styles, so the 32x14 thumb
  // below it never painted in any shipping browser (measured in Chromium).
  const css = read(MIXER_CSS);
  const effective = uncomment(css);
  assert.equal(declAt(css, NARROWEST, '.fader', 'writing-mode'), 'vertical-lr');
  assert.equal(declAt(css, NARROWEST, '.fader', 'direction'), 'rtl'); // zero at the bottom
  // THE REGRESSION GUARD. Fails on the code that shipped the bug (which
  // declared `-webkit-appearance: slider-vertical` on `.fader`), passes on the
  // fix, and cannot be satisfied by a comment.
  assert.doesNotMatch(effective, /slider-vertical/, 'a native slider widget disables the custom thumb');
  // THE POSITIVE FORM. The custom thumb can only paint if the control is not
  // drawing its native widget, in BOTH spellings.
  assert.equal(declAt(css, NARROWEST, '.fader', 'appearance'), 'none');
  assert.equal(declAt(css, NARROWEST, '.fader', '-webkit-appearance'), 'none');
  // COHERENCE. The custom thumb has a declared box to paint, and does not
  // itself opt back into a native appearance.
  assert.equal(declAt(css, NARROWEST, '.fader::-webkit-slider-thumb', 'appearance'), 'none');
  assert.equal(declAt(css, NARROWEST, '.fader::-webkit-slider-thumb', '-webkit-appearance'), 'none');
  assert.ok(declAt(css, NARROWEST, '.fader::-webkit-slider-thumb', 'width'), 'thumb has a width');
  assert.ok(declAt(css, NARROWEST, '.fader::-webkit-slider-thumb', 'height'), 'thumb has a height');
  assert.doesNotMatch(effective, /transform:\s*rotate/); // hit area must follow the paint
});

test('gain of exactly 0 and exactly 1 render as 0% and 100%', () => {
  const html = render({
    stems: withSilence([
      stem('drums', { gain: 0 }),
      stem('bass', { gain: 1 }),
      ...PLAYABLE_STEMS.slice(2).map((n) => stem(n, { gain: 0.5 })),
    ]),
    ...handlers(),
  });
  assert.equal(attr(faderFor(html, 'drums'), 'value'), '0');
  assert.equal(attr(faderFor(html, 'drums'), 'aria-valuenow'), '0');
  assert.equal(attr(faderFor(html, 'bass'), 'value'), '100');
  assert.equal(attr(faderFor(html, 'bass'), 'aria-valuenow'), '100');
  assert.match(html, /0%/);
  assert.match(html, /100%/);
});

test('gain conversions clamp at both ends and survive junk', () => {
  assert.equal(Mixer.gainToPercent(0), 0);
  assert.equal(Mixer.gainToPercent(1), 100);
  assert.equal(Mixer.gainToPercent(0.5), 50);
  assert.equal(Mixer.gainToPercent(-0.5), 0);
  assert.equal(Mixer.gainToPercent(1.5), 100);
  assert.equal(Mixer.gainToPercent(NaN), 0);
  assert.equal(Mixer.gainToPercent(Infinity), 100);
  assert.equal(Mixer.gainToPercent(-Infinity), 0);
  assert.equal(Mixer.clampGain(0), 0);
  assert.equal(Mixer.clampGain(1), 1);
  assert.equal(Mixer.percentToGain(0), 0);
  assert.equal(Mixer.percentToGain(100), 1);
  assert.equal(Mixer.percentToGain(37), 0.37);
  assert.equal(Mixer.percentToGain(1000), 1);
  assert.equal(Mixer.percentToGain(NaN), 0);
});

// ═══ Criteria 3 & 4 — mute and solo ══════════════════════════════════════════

test('every fader has a real mute toggle and a real solo toggle with pressed state', () => {
  const html = render({ stems: allReady(), ...handlers() });
  for (const name of PLAYABLE_STEMS) {
    const m = buttonFor(html, cap(name), 'Mute');
    const s = buttonFor(html, cap(name), 'Solo');
    assert.ok(m, `mute button for ${name}`);
    assert.ok(s, `solo button for ${name}`);
    assert.equal(attr(m, 'type'), 'button');
    assert.equal(attr(s, 'type'), 'button');
    assert.equal(attr(m, 'aria-pressed'), 'false');
    assert.equal(attr(s, 'aria-pressed'), 'false');
  }
  assert.equal((html.match(/data-role="mute"/g) ?? []).length, 6);
  assert.equal((html.match(/data-role="solo"/g) ?? []).length, 6);
});

test('solo is additive: all six soloed renders six pressed solos and no muted channel', () => {
  const html = render({ stems: allReady({ soloed: true }), ...handlers() });
  const pressedSolos = [...html.matchAll(/aria-label="Solo \w+" aria-pressed="(\w+)"/g)];
  // attribute order in markup follows JSX order; assert via the helper instead
  for (const name of PLAYABLE_STEMS) {
    assert.equal(attr(buttonFor(html, cap(name), 'Solo'), 'aria-pressed'), 'true', name);
    assert.equal(attr(buttonFor(html, cap(name), 'Mute'), 'aria-pressed'), 'false', name);
    assert.ok(!channelTag(html, name).includes('isMuted'), `${name} is not dressed as muted`);
  }
  assert.ok(pressedSolos.length === 0 || pressedSolos.length === 6); // order-insensitive
});

test('all six muted: six pressed mutes, and every channel wears the muted treatment', () => {
  const html = render({ stems: allReady({ muted: true }), ...handlers() });
  for (const name of PLAYABLE_STEMS) {
    assert.equal(attr(buttonFor(html, cap(name), 'Mute'), 'aria-pressed'), 'true', name);
    assert.ok(channelTag(html, name).includes('isMuted'), name);
    assert.equal(noteFor(html, name), 'Muted');
  }
  // still six working faders — muting is not disabling
  assert.equal(faders(html).filter((f) => f.includes('disabled')).length, 0);
});

test('one stem soloed: the others look DUCKED, not muted — different state, different look', () => {
  const stems = withSilence(
    PLAYABLE_STEMS.map((n) => stem(n, { soloed: n === 'vocals' })),
  );
  const html = render({ stems, ...handlers() });

  const vocals = channelTag(html, 'vocals');
  assert.ok(vocals.includes('isSoloed'));
  assert.ok(!vocals.includes('isDucked'));
  assert.ok(!vocals.includes('isMuted'));
  assert.equal(noteFor(html, 'vocals'), '');

  for (const name of PLAYABLE_STEMS.filter((n) => n !== 'vocals')) {
    const tag = channelTag(html, name);
    assert.ok(tag.includes('isDucked'), `${name} ducked`);
    assert.ok(!tag.includes('isMuted'), `${name} must NOT read as muted`);
    assert.equal(attr(buttonFor(html, cap(name), 'Mute'), 'aria-pressed'), 'false', name);
    assert.match(noteFor(html, name), /another stem is soloed/i);
  }
});

test('muted and ducked are different markup AND different copy', () => {
  const stems = withSilence([
    stem('drums', { muted: true }),
    stem('bass', { soloed: true }),
    ...PLAYABLE_STEMS.slice(2).map((n) => stem(n)),
  ]);
  const html = render({ stems, ...handlers() });
  const drums = channelTag(html, 'drums'); // muted by the user
  const guitar = channelTag(html, 'guitar'); // quiet because bass is soloed
  assert.ok(drums.includes('isMuted'));
  assert.ok(
    !drums.includes('isDucked'),
    'a user-muted channel must not also be marked as ducked — those are different states',
  );
  assert.ok(guitar.includes('isDucked'));
  assert.ok(!guitar.includes('isMuted'));
  assert.notEqual(noteFor(html, 'drums'), noteFor(html, 'guitar'));
  assert.equal(noteFor(html, 'drums'), 'Muted');
  assert.match(noteFor(html, 'guitar'), /soloed/i);
  // and the stylesheet really gives them different treatments. Ducking used to
  // be `opacity` on the whole channel; it is now on the fader column only, so
  // the words on a live ducked channel stay at full contrast.
  const css = read(MIXER_CSS);
  assert.match(declAt(css, NARROWEST, '.isMuted .name', 'text-decoration'), /line-through/);
  // `forced-colors` is pinned because this stylesheet restates the dimming
  // there: unpinned, the lookup refuses rather than picking one side.
  assert.equal(
    declAt(css, NARROWEST, '.isDucked:not(.isMuted) .slot', 'opacity', {
      env: { forcedColors: 'none' },
    }),
    '0.55',
  );
  assert.equal(declAt(css, NARROWEST, '.isDucked:not(.isMuted) .note', 'font-style'), 'italic');
});

test('silenceReason names the state it was given and never recomputes solo', () => {
  const r = (over) => Mixer.silenceReason(stem('drums', over));
  assert.equal(r({ muted: false, soloed: false, effectivelySilent: false }), null);
  assert.equal(r({ muted: true, soloed: false, effectivelySilent: true }), 'muted');
  assert.equal(r({ muted: true, soloed: true, effectivelySilent: true }), 'muted');
  assert.equal(r({ muted: false, soloed: false, effectivelySilent: true }), 'solo-elsewhere');
  // a soloed stem the engine still calls silent: reported, not explained away
  assert.equal(r({ muted: false, soloed: true, effectivelySilent: true }), 'silent');
  assert.equal(r({ muted: false, soloed: true, effectivelySilent: false }), null);
  // mute wins even if the engine forgot to flag it
  assert.equal(r({ muted: true, soloed: false, effectivelySilent: false }), 'muted');
  assert.equal(Mixer.silenceText(null), '');
  assert.notEqual(Mixer.silenceText('muted'), Mixer.silenceText('solo-elsewhere'));
});

// ═══ Criteria 5 & 6 — the component must not defeat the engine ═══════════════

test('rapid drag input is coalesced: 200 pushes on one stem become ONE onGain, last value', () => {
  const seen = [];
  let queued = null;
  const coalescer = Mixer.makeGainCoalescer((s, g) => seen.push([s, g]), (run) => {
    queued = run;
  });
  for (let i = 0; i <= 200; i++) coalescer.push('drums', i / 200);
  assert.equal(seen.length, 0, 'nothing emitted before the frame runs');
  queued();
  assert.deepEqual(seen, [['drums', 1]]);
});

test('coalescing is per stem: six stems dragged in one frame emit six times, not thirty', () => {
  const seen = [];
  let queued = null;
  const c = Mixer.makeGainCoalescer((s, g) => seen.push([s, g]), (run) => (queued = run));
  for (let round = 0; round < 5; round++) {
    for (const name of PLAYABLE_STEMS) c.push(name, round / 10);
  }
  queued();
  assert.equal(seen.length, 6);
  assert.deepEqual(seen.map((e) => e[0]), [...PLAYABLE_STEMS]);
  assert.ok(seen.every(([, g]) => g === 0.4), 'the last value of the frame won');
});

test('flush() lands the released value immediately; a later frame does not double-emit', () => {
  const seen = [];
  let queued = null;
  const c = Mixer.makeGainCoalescer((s, g) => seen.push([s, g]), (run) => (queued = run));
  c.push('bass', 0.3);
  c.flush();
  assert.deepEqual(seen, [['bass', 0.3]]);
  queued(); // the frame that was already scheduled
  assert.equal(seen.length, 1, 'no duplicate emit');
});

test('coalescer: cancel drops pending work, and a push from inside emit re-arms', () => {
  const seen = [];
  const frames = [];
  const c = Mixer.makeGainCoalescer((s, g) => {
    seen.push([s, g]);
    if (seen.length === 1) c.push('keys', 0.2); // e.g. a React state echo
  }, (run) => frames.push(run));
  c.push('drums', 0.9);
  frames.shift()();
  assert.equal(frames.length, 1, 're-armed for the next frame');
  frames.shift()();
  assert.deepEqual(seen, [['drums', 0.9], ['keys', 0.2]]);

  c.push('other', 0.5);
  assert.equal(c.pendingCount, 1);
  c.cancel();
  assert.equal(c.pendingCount, 0);
  c.flush();
  assert.equal(seen.length, 2, 'cancel really dropped it');
});

test('coalescer clamps on the way in, so the engine never sees an out-of-range gain', () => {
  const seen = [];
  let queued = null;
  const c = Mixer.makeGainCoalescer((s, g) => seen.push(g), (run) => (queued = run));
  c.push('drums', 42);
  c.push('bass', -7);
  c.push('keys', NaN);
  queued();
  assert.deepEqual(seen, [1, 0, 0]);
});

test('children are keyed by stem name, never by index, and the mixer does not remount on change', () => {
  const src = uncommentTs(read(MIXER_TSX));
  assert.match(src, /key=\{row\.stem\.name\}/);
  assert.doesNotMatch(src, /key=\{\s*(i|idx|index)\s*\}/);
  // the one gain path into the engine goes through the coalescer
  assert.match(src, /makeGainCoalescer\(\s*\(stem, gain\) => callbacks\.current\.onGain/);
  // and the channel is memoised, so one fader move re-renders one channel
  assert.match(src, /const Channel = memo\(/);
});

test('first paint calls no callbacks (nothing is "applied" just by rendering)', () => {
  const boom = (what) => () => assert.fail(`render called ${what}`);
  assert.doesNotThrow(() =>
    render({
      stems: allReady(),
      onGain: boom('onGain'),
      onMute: boom('onMute'),
      onSolo: boom('onSolo'),
    }),
  );
});

// ═══ Criterion 7 — remembered per job for the session ════════════════════════

test('mixerMemoryKey is per job and versioned', () => {
  assert.equal(Mixer.mixerMemoryKey('job-123'), 'sl.play.mixer.v1.job-123');
  assert.notEqual(Mixer.mixerMemoryKey('a'), Mixer.mixerMemoryKey('b'));
});

test('session memory round-trips gain, mute and solo for every stem', () => {
  const stems = withSilence([
    stem('drums', { gain: 0 }),
    stem('bass', { gain: 1 }),
    stem('guitar', { gain: 0.42, muted: true }),
    stem('keys', { gain: 0.5, soloed: true }),
    stem('vocals', { gain: 0.77 }),
    stem('other', { gain: 0.33 }),
  ]);
  const back = Mixer.parseMixerMemory(JSON.stringify(Mixer.snapshotMemory(stems)));
  assert.equal(back.drums.gain, 0);
  assert.equal(back.bass.gain, 1);
  assert.equal(back.guitar.gain, 0.42);
  assert.equal(back.guitar.muted, true);
  assert.equal(back.keys.soloed, true);
  assert.equal(Object.keys(back).length, 6);
});

test('parseMixerMemory never throws and never trusts what it reads', () => {
  for (const junk of [null, undefined, '', 'not json', '[]', '7', '"x"', '{"drums":1}', '{"drums":{}}']) {
    assert.deepEqual(Mixer.parseMixerMemory(junk), {}, JSON.stringify(junk));
  }
  const odd = Mixer.parseMixerMemory(
    '{"drums":{"gain":9,"muted":"yes"},"kazoo":{"gain":0.5},"bass":{"gain":null}}',
  );
  assert.deepEqual(Object.keys(odd), ['drums']);
  assert.equal(odd.drums.gain, 1, 'clamped');
  assert.equal(odd.drums.muted, false, 'only a real boolean counts');
});

test('memoryRestoreOps emits only real differences, and skips unavailable stems', () => {
  const rows = Mixer.mixerRows([
    stem('drums', { gain: 0.8 }),
    stem('bass', { gain: 0.8 }),
    stem('guitar', { availability: 'unavailable', gain: 0 }),
  ]);
  const memory = {
    drums: { gain: 0.8, muted: false, soloed: false }, // identical -> no op
    bass: { gain: 0.2, muted: true, soloed: false },
    guitar: { gain: 0.9, muted: false, soloed: false }, // unavailable -> skipped
    keys: { gain: 0.1, muted: false, soloed: false }, // absent -> skipped
  };
  assert.deepEqual(Mixer.memoryRestoreOps(memory, rows), [
    { stem: 'bass', gain: 0.2, muted: true },
  ]);
  assert.deepEqual(Mixer.memoryRestoreOps({}, rows), []);
});

// ═══ Stories 5.1 / 5.2 — a missing stem is disabled and says why ═════════════

test('an unavailable or encode_failed stem is disabled, labelled, and never looks normal', () => {
  const stems = withSilence([
    stem('drums'),
    stem('bass', { availability: 'unavailable', gain: 0 }),
    stem('guitar', { availability: 'encode_failed', gain: 0 }),
    stem('keys'),
    stem('vocals'),
    stem('other'),
  ]);
  const html = render({ stems, ...handlers() });

  for (const name of ['bass', 'guitar']) {
    const f = faderFor(html, name);
    assert.ok(f.includes('disabled'), `${name} fader disabled`);
    assert.equal(attr(f, 'aria-describedby'), `mixer-note-${name}`);
    assert.equal(attr(f, 'aria-valuetext'), 'Unavailable');
    assert.ok(buttonFor(html, cap(name), 'Mute').includes('disabled'));
    assert.ok(buttonFor(html, cap(name), 'Solo').includes('disabled'));
    assert.ok(channelTag(html, name).includes('isDisabled'));
    assert.match(noteFor(html, name), /^Unavailable — /);
  }
  // the two reasons are not the same sentence: the player says WHICH failure
  assert.notEqual(noteFor(html, 'bass'), noteFor(html, 'guitar'));
  assert.match(noteFor(html, 'guitar'), /failed to encode/i);
  assert.match(noteFor(html, 'bass'), /not produced/i);
  // and the available stems are untouched
  assert.ok(!faderFor(html, 'drums').includes('disabled'));
  assert.equal(noteFor(html, 'drums'), '');
});

test('EVERY stem unavailable: the mixer still renders six explained, inert channels', () => {
  const html = render({
    stems: PLAYABLE_STEMS.map((n) => stem(n, { availability: 'unavailable', gain: 0, effectivelySilent: true })),
    ...handlers(),
  });
  assert.equal(faders(html).length, 6);
  assert.equal(faders(html).filter((f) => f.includes('disabled')).length, 6);
  assert.equal((html.match(/<button[^>]*disabled/g) ?? []).length, 12);
  for (const name of PLAYABLE_STEMS) assert.match(noteFor(html, name), /Unavailable/);
  assert.equal((html.match(/—/g) ?? []).length >= 6, true, 'readouts show no fake level');
});

test('unavailableText distinguishes every availability, including an unknown one', () => {
  assert.equal(Mixer.unavailableText('ready', true), null);
  assert.match(Mixer.unavailableText('encode_failed', true), /encode/i);
  assert.match(Mixer.unavailableText('unavailable', true), /not produced/i);
  assert.match(Mixer.unavailableText('unavailable', false), /no audio was loaded/i);
  assert.match(Mixer.unavailableText('something_new', true), /not playable/i);
  const a = Mixer.unavailableText('encode_failed', true);
  const b = Mixer.unavailableText('unavailable', true);
  assert.notEqual(a, b);
});

test('mixerRows: disabled is derived from availability, not from gain or silence', () => {
  const rows = Mixer.mixerRows([
    stem('drums', { gain: 0, effectivelySilent: true, muted: true }), // silent but READY
    stem('bass', { availability: 'encode_failed', gain: 1 }), // loud-looking but DEAD
  ]);
  assert.equal(rows[0].disabled, false);
  assert.equal(rows[1].disabled, true);
});

// ═══ Accessibility ═══════════════════════════════════════════════════════════

test('each fader is a named slider with valuenow/min/max, and a keyboard-steppable range', () => {
  const html = render({ stems: allReady({ gain: 0.6 }), ...handlers() });
  for (const name of PLAYABLE_STEMS) {
    const f = faderFor(html, name);
    assert.equal(attr(f, 'aria-label'), `${cap(name)} level`);
    assert.equal(attr(f, 'aria-valuenow'), '60');
    assert.equal(attr(f, 'aria-valuemin'), '0');
    assert.equal(attr(f, 'aria-valuemax'), '100');
    assert.equal(attr(f, 'aria-valuetext'), '60 percent');
    assert.equal(attr(f, 'step'), '1'); // arrow keys move it; no custom keydown needed
  }
});

test('the mixer and each channel are labelled regions, and the legend is announced', () => {
  const html = render({ stems: allReady(), ...handlers() });
  assert.match(html, /<section class="mixer" aria-label="Stem mixer">/);
  for (const name of PLAYABLE_STEMS) {
    assert.match(html, new RegExp(`data-stem="${name}" role="group" aria-label="${cap(name)}"`));
  }
  assert.match(html, /M mutes a stem; S solos it/);
  assert.match(html, /several stems can be soloed at once/);
});

// ─── CSS geometry, resolved at the viewport that actually matters ────────────
//
// The test this replaces matched `height: 40px` with a regex and passed while
// the buttons rendered 19x40 and the rail overflowed by 30px at 360px. A regex
// over a stylesheet cannot see a box, so these read the DECLARED VALUES out of
// the CSS, resolve the tokens they reference, and do the width arithmetic.
//
// WHAT THAT IS AND IS NOT. It is not a measurement: nothing here lays out a
// box. What it IS is arithmetic over values that are every one of them READ,
// never restated, and read from the CASCADE THAT APPLIES AT 360px rather than
// from the base cascade.
//
// Both halves of that sentence were learned the hard way. A first version
// hard-coded the page gutter as `16` and the mixer border as `2` while
// claiming to track them. A second version resolved them but threw every
// `@media` block away, so a `@media (max-width: 759px)` override of the gutter
// or the channel floor — the same idiom this stylesheet uses in the other
// direction — was invisible, and the suite stayed green while the rail
// overflowed by 16px and by 44px and the sixth channel's Solo button sat
// outside the viewport entirely, unclickable.
//
// ═══ WHAT THIS GATE CANNOT DO ════════════════════════════════════════════════
//
// Four review rounds have each defeated it the same way, so this list is kept
// TRUE rather than reassuring. Two earlier versions of it were overclaims.
//
// 1. IT DOES NOT LAY OUT A BOX. This is the one limit that cannot be narrowed
//    by any amount of work here, and it is load-bearing. A `padding: 0 12px`
//    on `.toggles` rendered an M/S button at 22.66 x 44 — half the 44px
//    minimum asserted two screens down — and every rail overflow ever
//    demonstrated against this gate was invisible to the arithmetic. SO:
//    ANY GEOMETRIC CLAIM MUST BE MEASURED IN REAL CHROME AT THE WIDTHS THAT
//    MATTER AND THE NUMBERS RECORDED IN THE PR. The arithmetic's job is to
//    fail when a DECLARED value moves; it is not evidence that a box fits.
//
// 2. IT DOES NOT COMPUTE SPECIFICITY. It REFUSES — it does not answer —
//    whenever any rule in the cascade at this width, or in an at-rule it
//    cannot evaluate, has a selector whose SUBJECT compound contains the one
//    asked about and sets the property asked about or a relative of it. That
//    is strictly wider than the previous claim, which fired only on a
//    COMBINATOR plus an exact match among applied rules, and so missed
//    `.channel[data-stem]`, `.channel.channel`, `.channel:is(…)`,
//    `#x.channel` and anything at all inside `@supports`.
//
//    TWO EXEMPTIONS, BOTH NAMED IN FULL — the previous wording called them
//    "categorical, not heuristic", which was true of their FORM and false of
//    one of their CATEGORIES, and that framing is what stopped anyone looking
//    at the membership for a round. So the membership is now stated, not
//    characterised:
//      (a) A pseudo-ELEMENT is a different box.
//          `.fader::-webkit-slider-runnable-track { width }` cannot size
//          `.fader`. Sound; nothing has defeated it. But a `::before` /
//          `::after` box can still grow or overflow its PARENT, which is
//          geometry and therefore limit 1's problem, not this guard's.
//      (b) Exactly SIX pseudo-classes are exempt: `:hover`, `:focus`,
//          `:focus-visible`, `:focus-within`, `:active`, `:target`. Each needs
//          the user to be pointing at, typing into or navigating to the
//          element. NOTHING ELSE IS EXEMPT — in particular `:disabled`,
//          `:checked`, `:enabled`, `:valid`, `:invalid`, `:read-only`,
//          `:placeholder-shown`, `:link`, `:visited`, `:open` and
//          `:autofill` are RESTING states and are refused. This list held
//          twenty-one until a reviewer shrank the disabled touch target to
//          20px with `.toggle:disabled { min-height: 20px }` and the suite
//          stayed 65/65 green. See PSEUDO_STATE.
//
//    THE RESTING STATE IS THE ONLY STATE THESE LOOKUPS RESOLVE, and after
//    that fix they resolve it genuinely rather than nominally.
//
// 3. IT DOES NOT EVALUATE `@supports` OR `@layer`, AND REFUSES ON BOTH — now
//    including a selector inside one that merely OUTRANKS the one asked
//    about, not only one that matches it exactly. A statement at-rule
//    (`@layer base;`, `@import …;`) is refused outright: it reorders the
//    cascade and pulls in other files, and it used to be absorbed into the
//    next rule's prelude, deleting that rule from the model altogether.
//
// 4. IT IS PROPERTY-EXACT, AND REFUSES RATHER THAN EXPANDING A SHORTHAND. If
//    a selector declares both the property asked about and a relative of it
//    (`padding` against `padding-inline`, `gap` against `row-gap`), the
//    lookup fails. Expanding shorthands correctly is not a thing a regex can
//    do, so it does not try.
//
// 5. IT READS ONE FILE AT A TIME AND MODELS NO CROSS-FILE SOURCE ORDER.
//    `pageGutter()` is sound only because `--sl-gutter` has exactly one
//    declaring file, so that invariant is ASSERTED below rather than assumed.
//
// 6. NO ENVIRONMENT AXIS HAS A DEFAULT. Every axis this stylesheet branches
//    on is either pinned by the caller or evaluated at every value, and a
//    disagreement between those values is a refusal. A previous version
//    merely STATED `colorScheme: 'dark'`, and a `prefers-color-scheme: light`
//    override of the channel floor passed while light mode overflowed by
//    608px.
//
// Width, `!important` and comma-separated media lists ARE resolved, and the
// resolver's own behaviour on each of these shapes is pinned by tests below.

const TOKENS_CSS = 'src/styles/design-tokens.css';

/** The narrowest viewport the mixer promises to fit every channel in. */
const NARROWEST = 360;

/**
 * The EFFECTIVE text of a stylesheet: comments blanked, everything else kept.
 *
 * This used to be `css.replace(/\/\*[\s\S]*?\*\//g, '')`, which is unsound in
 * four measured ways: (1) an UNTERMINATED `/*` is left in as live text, but CSS
 * Syntax runs it to end of file, so a comment-blind assertion could still be
 * satisfied by it; (2) a `/*` inside a string (`content: "/*"`) opened a
 * "comment" that swallowed real rules up to the next `*\/`; (3) the same inside
 * an unquoted `url(...)`; (4) deleting rather than blanking fused `a/**\/b`
 * into `ab` and threw away line numbers. This is a scanner, not a regex:
 * strings and unquoted url() are opaque, an unterminated comment runs to EOF,
 * and every comment character except a newline becomes a space so that
 * columns and line numbers still point at the real file.
 */
const uncomment = (css) => {
  let out = '';
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const stop = close === -1 ? css.length : close + 2;
      out += blank(css.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (/^url\(\s*[^\s"')]/i.test(css.slice(i, i + 12))) {
      const close = css.indexOf(')', i);
      const stop = close === -1 ? css.length : close + 1;
      out += css.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
};

/**
 * The EFFECTIVE text of a TS/TSX source: every comment blanked, found by the
 * real parser. A regex cannot do this: `//` inside a string, a template or JSX
 * text (`https://...`, `don't`) is not a comment, and `/*` inside a regex
 * literal is not either. Newlines are kept so line numbers still line up.
 */
const uncommentTs = (src) => {
  const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const ranges = new Map();
  const visit = (node) => {
    for (const child of node.getChildren(sf)) {
      if (child.kind !== ts.SyntaxKind.JsxText) {
        const pos = child.getFullStart();
        for (const r of ts.getLeadingCommentRanges(src, pos) ?? []) ranges.set(r.pos, r.end);
        for (const r of ts.getTrailingCommentRanges(src, child.getEnd()) ?? []) ranges.set(r.pos, r.end);
      }
      visit(child);
    }
  };
  visit(sf);
  let out = src;
  for (const [pos, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
};

/**
 * The environment axes this resolver knows how to enumerate. These are NOT
 * defaults — nothing here states a value. An axis the stylesheet branches on
 * is either PINNED by the caller or evaluated at EVERY value below, and a
 * disagreement between those values is a refusal, not a pick. That is the
 * fix for the last false green of round 4: a `DEFAULT_ENV` that merely
 * *stated* `colorScheme: 'dark'` let a `@media (prefers-color-scheme: light)`
 * override of the channel floor pass while light mode overflowed by 608px.
 */
const AXES = {
  forcedColors: { feature: 'forced-colors', values: ['none', 'active'] },
  reducedMotion: { feature: 'prefers-reduced-motion', values: ['no-preference', 'reduce'] },
  colorScheme: { feature: 'prefers-color-scheme', values: ['light', 'dark'] },
};

/**
 * Properties that can overwrite each other without sharing a name. The
 * declaration lookup below is PROPERTY-EXACT, so a shorthand and its longhand
 * are mutually invisible to it: `.toggles { padding-inline: 0 }` followed by
 * `.toggles { padding: 0 12px }` left the gate reading `0` while Chrome laid
 * the M/S button out at 22.66 x 44 — half the 44px minimum the same test
 * asserts. Expanding shorthands correctly is not something a regex can do, so
 * this does not try: if a selector declares the property asked about AND a
 * relative of it, the lookup REFUSES. `border-radius` is deliberately not a
 * relative of `border` — the `border` shorthand does not set it.
 */
const PROP_FAMILIES = [
  ['padding', 'padding-inline', 'padding-block', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'padding-inline-start', 'padding-inline-end',
    'padding-block-start', 'padding-block-end'],
  ['margin', 'margin-inline', 'margin-block', 'margin-top', 'margin-right',
    'margin-bottom', 'margin-left', 'margin-inline-start', 'margin-inline-end',
    'margin-block-start', 'margin-block-end'],
  ['border', 'border-width', 'border-style', 'border-color', 'border-top', 'border-right',
    'border-bottom', 'border-left', 'border-inline', 'border-block',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-inline-width', 'border-block-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  ['inset', 'top', 'right', 'bottom', 'left', 'inset-inline', 'inset-block'],
  ['gap', 'row-gap', 'column-gap'],
  ['flex', 'flex-grow', 'flex-shrink', 'flex-basis'],
  ['flex-flow', 'flex-direction', 'flex-wrap'],
  ['overflow', 'overflow-x', 'overflow-y'],
  ['width', 'inline-size'],
  ['height', 'block-size'],
  ['min-width', 'min-inline-size'],
  ['min-height', 'min-block-size'],
  ['max-width', 'max-inline-size'],
  ['max-height', 'max-block-size'],
  ['font', 'font-style', 'font-weight', 'font-size', 'font-family', 'line-height'],
  ['background', 'background-color', 'background-image'],
  ['transition', 'transition-property', 'transition-duration'],
];

/** Every property that could overwrite `prop` without being spelled `prop`. */
const relatives = (prop) => {
  const out = new Set();
  for (const family of PROP_FAMILIES) {
    if (family.includes(prop)) for (const other of family) if (other !== prop) out.add(other);
  }
  return [...out];
};

/** `.a:hover .b` -> `.b`: the compound that picks the element being styled. */
const subject = (selectorText) => selectorText.trim().split(/\s*[ >+~]\s*/).filter(Boolean).pop() ?? '';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The SIX pseudo-classes the override guard exempts, exhaustively, and nothing
 * else: `:hover`, `:focus`, `:focus-visible`, `:focus-within`, `:active`,
 * `:target`. Every one of them requires the user to be pointing at, typing
 * into, or navigating to the element, so a rule gated on one of them cannot be
 * the rule that answers a RESTING-state question — `.slot:focus-within
 * { opacity: 1 }` does not make the ducked slot's resting 0.55 wrong.
 *
 * THIS LIST USED TO HOLD TWENTY-ONE, AND THAT WAS A FALSE GREEN OF ITS OWN.
 * Fifteen of the extras — `:disabled`, `:enabled`, `:checked`,
 * `:indeterminate`, `:read-only`, `:read-write`, `:valid`, `:invalid`,
 * `:default`, `:placeholder-shown`, `:link`, `:visited`, `:open`,
 * `:popover-open`, `:autofill` — describe a RESTING state: a rule gated on one
 * of them applies with nobody touching the page at all. `:disabled` is the one
 * this component actively renders (`disabled: stem.availability !== 'ready'`,
 * Mixer.tsx), and in the absent-stem case this file tests, FIFTEEN of the
 * mixer's controls carry it at first paint. So `.toggle:disabled
 * { min-height: 20px }` was exempted from the guard, resolved by nobody, and
 * passed 65/65 while Chrome rendered a 20px-tall touch target on every
 * disabled channel — against the 44px floor asserted a few screens down, whose
 * own comment promises the box "may grow but never shrink under the target".
 * `.fader:disabled { width: 10px }` did the same to the 44px fader column.
 *
 * The lesson is in the wording as much as the regex. The old comment called
 * this a TRANSIENT-state exemption while the list exempted resting states, and
 * the disclosure called it "categorical, not heuristic" — categorical in form,
 * but the category was mislabelled, and that framing discouraged the scrutiny
 * a heuristic would have invited. Anything NOT on this list of six — `:is`,
 * `:not`, `:nth-child`, `:disabled`, an attribute, a second class, an id — is
 * treated as outranking and REFUSED.
 */
const PSEUDO_STATE = /:(?:hover|focus-visible|focus-within|focus|active|target)\b/g;

/**
 * Does `needle` appear in `hay` as a whole compound token rather than as the
 * head of a longer identifier? `.toggle` must not match inside `.toggles`.
 */
const hasToken = (hay, needle) =>
  new RegExp(`${esc(needle)}(?![A-Za-z0-9_-])`).test(hay);

/**
 * `prop: value` pairs out of one rule body, with `!important` modelled.
 * Nesting is refused rather than mis-parsed: a `&`-nested block inside a rule
 * would make this split a selector as if it were a declaration.
 */
const declarations = (decls, where) => {
  assert.ok(
    !decls.includes('{'),
    `nested rules inside \`${where}\` are not modelled by this resolver; teach it or flatten the rule`,
  );
  const out = [];
  let depth = 0;
  let start = 0;
  const push = (piece) => {
    const text = piece.trim();
    if (text.length === 0) return;
    const colon = text.indexOf(':');
    if (colon === -1) return;
    const prop = text.slice(0, colon).trim();
    let value = text.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, '').trim();
    out.push({ prop, value, important });
  };
  for (let i = 0; i < decls.length; i += 1) {
    const ch = decls[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) {
      push(decls.slice(start, i));
      start = i + 1;
    }
  }
  push(decls.slice(start));
  return out;
};

/**
 * Every style rule that applies at `width` in `env`, in source order,
 * separated from the ones this file cannot evaluate.
 *
 * `@media` blocks are kept when their conditions hold and dropped when they do
 * not, so what comes back is the cascade that renders there. Anything whose
 * condition cannot be evaluated here goes to `unevaluated` rather than being
 * guessed at, and the lookups below fail loudly if one of those touches a
 * value they were asked for. Failing closed is the point: a silent wrong
 * answer is what put a launch-blocking layout defect through this gate twice.
 */
const rulesAt = (css, env) => {
  const { width } = env;
  const applied = [];
  const unevaluated = [];
  const feature = {
    'forced-colors': env.forcedColors,
    'prefers-reduced-motion': env.reducedMotion,
    'prefers-color-scheme': env.colorScheme,
  };

  /** Split on commas that are not inside parentheses. */
  const commaParts = (text) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
      else if (text[i] === ',' && depth === 0) {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(text.slice(start));
    return parts.map((one) => one.trim()).filter((one) => one.length > 0);
  };

  /**
   * true / false / null ("cannot tell") for ONE comma-free media query.
   * `not`, range syntax (`400px <= width <= 800px`) and any feature not in
   * AXES all leave something behind in `leftover` and answer null.
   */
  const holdsOne = (query) => {
    const WIDTH = /\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)/g;
    const FEATURE = /\(\s*(forced-colors|prefers-reduced-motion|prefers-color-scheme)\s*:\s*([a-z-]+)\s*\)/g;
    const widths = [...query.matchAll(WIDTH)];
    const features = [...query.matchAll(FEATURE)];
    const leftover = query
      .replace(WIDTH, '')
      .replace(FEATURE, '')
      .replace(/\band\b|\bonly\b|\bscreen\b|\ball\b|\s/g, '');
    if (leftover.length > 0 || widths.length + features.length === 0) return null;
    for (const [, name] of features) {
      assert.ok(
        feature[name] !== undefined,
        `\`${name}\` is an environment axis with no value in this lookup; add it to AXES`,
      );
    }
    return (
      widths.every(([, kind, n]) => (kind === 'min' ? width >= Number(n) : width <= Number(n))) &&
      features.every(([, name, want]) => feature[name] === want)
    );
  };

  /**
   * A media prelude is a comma-separated LIST, and the list is an OR. The
   * previous version stripped the commas and then ANDed the lot, which is the
   * only one of round 4's six false greens that was a CONFIDENT WRONG ANSWER
   * rather than a missed override: `@media (max-width: 400px), (min-width:
   * 760px)` applies at 360px in Chrome and was evaluated as false here, so the
   * 72px channel floor vanished and the sixth Solo button sat at x=400..470,
   * outside the viewport, with the suite green.
   */
  const holds = (prelude) => {
    const verdicts = commaParts(prelude.replace(/^@media\b/, '')).map(holdsOne);
    if (verdicts.length === 0) return null;
    if (verdicts.some((v) => v === true)) return true;
    if (verdicts.every((v) => v === false)) return false;
    return null;
  };

  const walk = (text, state) => {
    let i = 0;
    for (;;) {
      const brace = text.indexOf('{', i);
      // A STATEMENT at-rule — `@layer base;`, `@import url(…);`, `@charset` —
      // ends at a semicolon and has no block. The previous version looked only
      // for the next `{`, so the statement was absorbed into the FOLLOWING
      // rule's prelude, that prelude then started with `@`, and the rule it
      // swallowed disappeared from `applied` and `unevaluated` alike. A lookup
      // that expected `null` (`{ required: false }`) then read the absence as
      // "nothing declares it" and passed. `@layer` and `@import` also change
      // the cascade in ways nothing here models, so this refuses outright.
      const semi = text.indexOf(';', i);
      if (semi !== -1 && (brace === -1 || semi < brace)) {
        const statement = text.slice(i, semi).trim();
        assert.ok(
          statement.length === 0,
          `\`${statement.slice(0, 60)}\` is a statement at-rule; it changes the cascade in ways ` +
            `this resolver does not model (layer order, cross-file source order). Teach it or remove it`,
        );
        i = semi + 1;
        continue;
      }
      if (brace === -1) return;
      const prelude = text.slice(i, brace).trim();
      let depth = 0;
      let j = brace;
      for (; j < text.length; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      assert.ok(depth === 0, `unbalanced braces after \`${prelude.slice(0, 40)}\``);
      const body = text.slice(brace + 1, j);
      if (prelude.startsWith('@')) {
        const verdict = prelude.startsWith('@media') ? holds(prelude) : null;
        const next =
          verdict === false || state === 'excluded'
            ? 'excluded'
            : verdict === true
              ? state
              : 'unknown';
        walk(body, next);
      } else if (state !== 'excluded') {
        (state === 'applied' ? applied : unevaluated).push({
          selectors: prelude.split(',').map((one) => one.trim()),
          decls: declarations(body, prelude),
        });
      }
      i = j + 1;
    }
  };

  walk(uncomment(css), 'applied');
  return { applied, unevaluated };
};

/**
 * The winning value of `selector { prop }` in ONE resolved environment, or a
 * loud failure if anything about the cascade there is beyond this resolver.
 *
 * Only rules whose selector list contains `selector` EXACTLY are consulted, so
 * `.isMuted .name` never answers a question about `.name`. Everything that
 * could make that exact match the wrong answer is a refusal:
 *   - a selector that targets the same element through a longer compound,
 *   - the same property under a different name (shorthand / longhand),
 *   - any of the above inside an at-rule this file cannot evaluate.
 */
const declIn = (css, selector, prop, env) => {
  const { applied, unevaluated } = rulesAt(css, env);

  // ── refusal 1: a selector that outranks the one asked about ───────────────
  //
  // Widened in round 4 from `[ >+~]<selector>$` — a COMBINATOR plus an exact
  // match, over `applied` only — which fired on `.mixer .channel` but was
  // silent on `.channel[data-stem]`, `.channel.channel`, `#x.channel` and
  // `.channel:is(…)`, every one of which outranks `.channel`, and silent on
  // anything inside `@supports`. Now: any selector whose SUBJECT compound
  // contains this one, in `applied` or `unevaluated`. A selector that the
  // asked-for one CONTAINS is exempt, since `.slot` cannot outrank
  // `.isDucked:not(.isMuted) .slot`.
  const want = subject(selector);
  for (const [state, rules] of [['applies', applied], ['may apply', unevaluated]]) {
    for (const rule of rules) {
      for (const one of rule.selectors) {
        if (one === selector) continue;
        // A pseudo-ELEMENT is a different box: `.fader::-webkit-slider-runnable-track
        // { width }` sizes the generated track, never `.fader` itself.
        if (subject(one).includes('::')) continue;
        if (!hasToken(subject(one), want)) continue;
        if (hasToken(selector, one)) continue; // weaker form of the same selector
        const resting = one.replace(PSEUDO_STATE, '');
        // the same element, reachable only while the user is pointing at,
        // typing into or navigating to it — never at rest. A RESTING-state
        // pseudo-class such as `:disabled` is NOT exempt; see PSEUDO_STATE.
        if (resting === selector || hasToken(selector, resting)) continue;
        const also = rule.decls.find((d) => d.prop === prop || relatives(prop).includes(d.prop));
        assert.ok(
          !also,
          `\`${one}\` sets \`${also?.prop}\` and outranks \`${selector}\` (${state} here); this ` +
            `lookup resolves selectors by exact match and would answer with the wrong value`,
        );
      }
    }
  }

  // ── refusal 2: the same box sized through a different property name ───────
  const kin = relatives(prop);
  for (const rules of [applied, unevaluated]) {
    for (const rule of rules) {
      if (!rule.selectors.includes(selector)) continue;
      const sibling = rule.decls.find((d) => kin.includes(d.prop));
      assert.ok(
        !sibling,
        `\`${selector}\` declares both \`${prop}\` and \`${sibling?.prop}\`, which can overwrite ` +
          `each other; this lookup is property-exact and cannot tell which wins`,
      );
    }
  }

  /** Last declaration wins — except that any `!important` one beats all of them. */
  const winner = (rules) => {
    let normal = null;
    let important = null;
    for (const rule of rules) {
      if (!rule.selectors.includes(selector)) continue;
      for (const d of rule.decls) {
        if (d.prop !== prop) continue;
        if (d.important) important = d.value;
        else normal = d.value;
      }
    }
    return important ?? normal;
  };

  // ── refusal 3: the value is set inside an at-rule this file cannot judge ──
  const blind = winner(unevaluated);
  assert.equal(
    blind,
    null,
    `\`${selector} { ${prop} }\` is set to \`${blind}\` inside an at-rule this test cannot ` +
      `evaluate — teach rulesAt about it rather than trusting the base value`,
  );
  return winner(applied);
};

/**
 * `selector { prop }` at `width`, resolved over EVERY value of every
 * environment axis the stylesheet branches on and that the caller has not
 * pinned. Agreement is the answer; disagreement is a refusal that names both
 * sides. Nothing is defaulted, so a stylesheet that grows a new axis cannot
 * quietly keep answering with one side of it.
 */
const declAt = (css, width, selector, prop, { required = true, env = {} } = {}) => {
  for (const key of Object.keys(env)) {
    assert.ok(AXES[key], `\`${key}\` is not an environment axis this resolver knows`);
  }
  const text = uncomment(css);
  const free = Object.entries(AXES).filter(
    ([key, { feature }]) => env[key] === undefined && text.includes(`${feature}:`),
  );
  let combos = [{ ...env, width }];
  for (const [key, { values }] of free) {
    combos = combos.flatMap((base) => values.map((v) => ({ ...base, [key]: v })));
  }
  const seen = combos.map((combo) => ({ combo, value: declIn(css, selector, prop, combo) }));
  const show = (c) => free.map(([key]) => `${AXES[key].feature}: ${c[key]}`).join(', ');
  const first = seen[0];
  for (const other of seen) {
    assert.equal(
      other.value,
      first.value,
      `\`${selector} { ${prop} }\` is \`${first.value}\` at (${show(first.combo)}) but ` +
        `\`${other.value}\` at (${show(other.combo)}); pin the axis you mean, or fix the disagreement`,
    );
  }
  if (required) {
    assert.ok(first.value !== null, `nothing declares \`${prop}\` for \`${selector}\` at ${width}px`);
  }
  return first.value;
};

/** The same lookup in forced-colors mode, where this stylesheet restates states. */
const declForcedColors = (css, width, selector, prop, opts = {}) =>
  declAt(css, width, selector, prop, { ...opts, env: { ...opts.env, forcedColors: 'active' } });

/** `12px` -> 12; `var(--space-2)` -> whatever the tokens say AT THIS WIDTH. */
const px = (value, width = NARROWEST) => {
  const direct = value.match(/^(-?[\d.]+)px$/);
  if (direct) return Number(direct[1]);
  const token = value.match(/^var\((--[a-z0-9-]+)\)$/);
  assert.ok(token, `cannot resolve \`${value}\` to px`);
  return px(declAt(read(TOKENS_CSS), width, ':root', token[1]), width);
};

/** The page gutter, read from the tokens that are in scope on every route. */
const pageGutter = (width = NARROWEST) => px(declAt(read(TOKENS_CSS), width, ':root', '--sl-gutter'), width);

// ═══ The resolver's own gate ══════════════════════════════════════════════════
//
// Four review rounds have each defeated this gate the same way: it answered a
// question about the cascade CONFIDENTLY and WRONGLY, and the suite stayed
// green while Chrome overflowed. Round 1 was a hard-coded literal, round 2 the
// base cascade instead of the 360px cascade, round 3 specificity, round 4 five
// more variants of specificity plus one genuine mis-evaluation.
//
// So the resolver is pinned here by its OWN behaviour on inline stylesheets,
// not only through the product CSS. Each case below is one of the shapes that
// produced a false green, and the assertion is either the right answer or a
// REFUSAL. A gate that refuses costs five minutes; a gate that answers wrongly
// is the defect. Where closing a hole cleanly would need a real CSS engine,
// this refuses on purpose and the residue list says so.

/** `declAt` must throw, and the message must name the reason. */
const refuses = (thunk, reason) =>
  assert.throws(thunk, (err) => {
    assert.match(err.message, reason);
    return true;
  });

test('resolver: a comma-separated media prelude is an OR, not an AND', () => {
  // THE CONFIDENT WRONG ANSWER. `holds()` stripped commas and then ANDed the
  // condition list that Chrome ORs, so this block was judged false at 360px.
  // In Chrome the 150px floor applies, six channels need 910px of 302px, and
  // the sixth Solo button sat at x=400..470 — outside the viewport, where
  // elementFromPoint returns nothing at all. This is the only one of round 4's
  // six that is fixed rather than refused: the list is parsed and ORed.
  const css = `
    .channel { min-width: 46px; }
    @media (max-width: 400px), (min-width: 760px) {
      .channel { min-width: 150px; }
    }`;
  assert.equal(declAt(css, 360, '.channel', 'min-width'), '150px', 'the max-width arm');
  assert.equal(declAt(css, 1024, '.channel', 'min-width'), '150px', 'the min-width arm');
  assert.equal(declAt(css, 500, '.channel', 'min-width'), '46px', 'neither arm');
  // and an OR where one arm is unevaluable still answers when another arm HOLDS
  assert.equal(
    declAt(`.a { gap: 1px } @media (min-width: 0px), (400px <= width) { .a { gap: 9px } }`, 360, '.a', 'gap'),
    '9px',
  );
  // …but refuses when the only arms are false-or-unknown
  refuses(
    () => declAt(`.a { gap: 1px } @media (min-width: 900px), (400px <= width) { .a { gap: 9px } }`, 360, '.a', 'gap'),
    /cannot\s+evaluate/,
  );
});

test('resolver: `!important` beats a later ordinary declaration', () => {
  // `winner()` took the last textual match and did not model `!important`, so
  // an earlier `!important` floor was invisible. Fixed, not refused.
  const css = `
    .channel { min-width: 150px !important; }
    .channel { min-width: 46px; }`;
  assert.equal(declAt(css, 360, '.channel', 'min-width'), '150px');
  // spacing and case are not load-bearing
  assert.equal(declAt(`.a { gap: 9px !  IMPORTANT ; } .a { gap: 1px }`, 360, '.a', 'gap'), '9px');
  // and the last `!important` wins over an earlier one
  assert.equal(
    declAt(`.a { gap: 2px !important } .a { gap: 9px !important } .a { gap: 1px }`, 360, '.a', 'gap'),
    '9px',
  );
});

test('resolver: refuses any selector that outranks the one asked about', () => {
  // The old guard keyed on `[ >+~]<selector>$` — a COMBINATOR plus an exact
  // match — so it caught `.mixer .channel` and was silent on every one of
  // these, each of which outranks `.channel` and each of which rendered a
  // 150px floor and a 608px overflow in Chrome with the suite green.
  for (const outranks of [
    '.channel[data-stem]',
    '.channel.channel',
    '.channel:is(.mixer)',
    '#job .channel',
    '.mixer .channel',
    '.mixer > .channel',
  ]) {
    refuses(
      () => declAt(`${outranks} { min-width: 150px; }\n.channel { min-width: 46px; }`, 360, '.channel', 'min-width'),
      /outranks/,
    );
  }
  // scanned in BOTH directions of source order, and for a RELATIVE of the
  // property as well as the property itself
  refuses(
    () => declAt(`.channel { min-width: 46px } .channel[x] { min-inline-size: 150px }`, 360, '.channel', 'min-width'),
    /outranks/,
  );
});

test('resolver: refuses an outranking selector inside an at-rule it cannot evaluate', () => {
  // The blind check over `unevaluated` was exact-match too, so a DESCENDANT
  // selector inside `@supports` passed silently — the gate's stated claim that
  // it "fails on @supports rather than evaluating it" was an overclaim.
  refuses(
    () =>
      declAt(
        `@supports (display: flex) { .mixer .channel { min-width: 150px; } }\n.channel { min-width: 46px; }`,
        360,
        '.channel',
        'min-width',
      ),
    /outranks .*may apply/,
  );
  // the exact-match blind check still fires too
  refuses(
    () => declAt(`@supports (display: flex) { .channel { min-width: 150px } }\n.channel { min-width: 46px }`, 360, '.channel', 'min-width'),
    /cannot\s+evaluate/,
  );
});

test('resolver: a RESTING-state pseudo-class outranks and is refused; only six are exempt', () => {
  // THE SEVENTH VARIANT. `PSEUDO_STATE` listed twenty-one pseudo-classes and
  // the guard stripped all of them, so `.toggle:disabled { min-height: 20px }`
  // was treated as "a different interaction state" and left unresolved — a
  // confident wrong answer, 65/65 green, while Chrome rendered the disabled
  // M/S button 46.67 x 20.00 at rest with no interaction at all. Fifteen of
  // the twenty-one describe a state that applies with nobody touching the
  // page. `:disabled` is the one this component renders, on 15 controls at
  // first paint in the absent-stem case (`disabled: stem.availability !==
  // 'ready'`). The exemption was never forced by this stylesheet: its only
  // `:disabled` rules set `cursor`, `color` and `border-color`.
  //
  // Both directions are pinned, so neither putting one back nor dropping one
  // of the six can pass.
  const RESTING = [
    'disabled', 'enabled', 'checked', 'indeterminate', 'read-only', 'read-write',
    'valid', 'invalid', 'default', 'placeholder-shown', 'link', 'visited',
    'open', 'popover-open', 'autofill',
  ];
  for (const state of RESTING) {
    refuses(
      () => declAt(`.toggle:${state} { min-height: 20px }\n.toggle { min-height: 44px }`, 360, '.toggle', 'min-height'),
      new RegExp(`\`\\.toggle:${state}\` sets \`min-height\` and outranks \`\\.toggle\``),
    );
  }
  // …and the six that genuinely need the user to be pointing at, typing into
  // or navigating to the element stay exempt, because this stylesheet really
  // does restate the ducked slot under `:focus-within`.
  const TRANSIENT = ['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'target'];
  for (const state of TRANSIENT) {
    assert.equal(
      declAt(`.toggle:${state} { min-height: 20px }\n.toggle { min-height: 44px }`, 360, '.toggle', 'min-height'),
      '44px',
      `:${state} is not a resting state and must stay exempt`,
    );
  }
  // the list is exhaustive in the other direction too: a pseudo-class nobody
  // thought about is treated as outranking rather than quietly exempted
  refuses(
    () => declAt(`.toggle:nth-child(2) { min-height: 20px }\n.toggle { min-height: 44px }`, 360, '.toggle', 'min-height'),
    /outranks/,
  );
});

test('resolver: the two disabled-state shrinks that defeated the touch-target floor', () => {
  // B1 and B2 verbatim, against the properties whose assertions they defeated:
  // `px(narrow('.toggle', 'min-height')) === touch` and
  // `px(at('.fader', 'width')) === touch`. Measured in Chrome at 360px at rest:
  // B1 gave a 20px-tall disabled M/S against the 44px floor (enabled stayed
  // 44px), B2 a 10px-wide disabled fader column (enabled stayed 44px).
  refuses(
    () => declAt(`.toggle:disabled { min-height: 20px; }\n.toggle { min-height: var(--touch-min); }`, 360, '.toggle', 'min-height'),
    /`\.toggle:disabled` sets `min-height` and outranks `\.toggle`/,
  );
  refuses(
    () => declAt(`.fader:disabled { width: 10px; }\n.fader { width: var(--touch-min); }`, 360, '.fader', 'width'),
    /`\.fader:disabled` sets `width` and outranks `\.fader`/,
  );
  // a pseudo-ELEMENT on the disabled state is still a different box, which is
  // what this stylesheet actually uses `:disabled` for
  assert.equal(
    declAt(`.fader:disabled::-webkit-slider-thumb { width: 10px }\n.fader { width: 44px }`, 360, '.fader', 'width'),
    '44px',
  );
  // and the real stylesheet's own `:disabled` rules set no geometry, so the
  // narrowing costs it nothing
  const css = read(MIXER_CSS);
  assert.equal(px(declAt(css, NARROWEST, '.fader', 'width')), px('var(--touch-min)'));
  assert.equal(px(declAt(css, NARROWEST, '.toggle', 'min-height')), px('var(--touch-min)'));
});

test('resolver: refuses a shorthand and its longhand on the same selector', () => {
  // THE LIVE RISK, not a hypothetical: this stylesheet already mixes both
  // idioms (`.channel { padding: … }` against `.toggles { padding-inline: 0 }`).
  // The declaration regex was property-exact, so `padding: 0 12px` after
  // `padding-inline: 0` was invisible and Chrome laid the M/S button out at
  // 22.66 x 44 — half the 44px minimum the touch-target test asserts.
  // Expanding shorthands is not something a regex can do, so this refuses.
  refuses(
    () => declAt(`.toggles { padding-inline: 0 } .toggles { padding: 0 12px }`, 360, '.toggles', 'padding-inline'),
    /declares both `padding-inline` and `padding`/,
  );
  // both directions, and the other families that matter to this stylesheet
  refuses(() => declAt(`.a { padding: 4px; padding-left: 9px }`, 360, '.a', 'padding'), /declares both/);
  refuses(() => declAt(`.a { gap: 2px; row-gap: 9px }`, 360, '.a', 'gap'), /declares both/);
  refuses(() => declAt(`.a { border: 1px solid red; border-width: 9px }`, 360, '.a', 'border'), /declares both/);
  refuses(() => declAt(`.a { width: 4px; inline-size: 9px }`, 360, '.a', 'width'), /declares both/);
  refuses(() => declAt(`.a { flex-direction: row; flex-flow: column }`, 360, '.a', 'flex-direction'), /declares both/);
  // `border-radius` is NOT a longhand of `border`, so this stylesheet's own
  // `.mixer { border; border-radius }` must keep answering
  assert.equal(declAt(`.a { border: 1px solid red; border-radius: 4px }`, 360, '.a', 'border'), '1px solid red');
});

test('resolver: no environment axis has a default; a disagreement is a refusal', () => {
  // `DEFAULT_ENV` *stated* `colorScheme: 'dark'` — itself the opposite of a
  // plain browser default — and nothing forced a test to consider the other
  // value, so a `prefers-color-scheme: light` override of the channel floor
  // passed while light mode overflowed by 608px and clipped the sixth Solo.
  const css = `
    .channel { min-width: 46px; }
    @media (prefers-color-scheme: light) { .channel { min-width: 150px; } }`;
  refuses(() => declAt(css, 360, '.channel', 'min-width'), /prefers-color-scheme: light.*prefers-color-scheme: dark/s);
  // pinning the axis is how a test says which one it means
  assert.equal(declAt(css, 360, '.channel', 'min-width', { env: { colorScheme: 'dark' } }), '46px');
  assert.equal(declAt(css, 360, '.channel', 'min-width', { env: { colorScheme: 'light' } }), '150px');
  // every axis, not just this one
  for (const [feature, pin, other] of [
    ['forced-colors: active', { forcedColors: 'none' }, { forcedColors: 'active' }],
    ['prefers-reduced-motion: reduce', { reducedMotion: 'no-preference' }, { reducedMotion: 'reduce' }],
  ]) {
    const sheet = `.a { gap: 1px } @media (${feature}) { .a { gap: 9px } }`;
    refuses(() => declAt(sheet, 360, '.a', 'gap'), /pin the axis you mean/);
    assert.equal(declAt(sheet, 360, '.a', 'gap', { env: pin }), '1px');
    assert.equal(declAt(sheet, 360, '.a', 'gap', { env: other }), '9px');
  }
  // an axis the stylesheet never branches on needs no pin
  assert.equal(declAt(`.a { gap: 1px }`, 360, '.a', 'gap'), '1px');
  // and a typo in a pin is a failure, not a silently ignored key
  refuses(() => declAt(`.a { gap: 1px }`, 360, '.a', 'gap', { env: { colourScheme: 'dark' } }), /not an environment axis/);
});

test('resolver: refuses a statement at-rule rather than swallowing the next rule', () => {
  // NEW HOLE, found in round 4 and never stated. `@layer base;` / `@import …;`
  // end at a semicolon, and the walker only looked for the next `{`, so the
  // statement was absorbed into the FOLLOWING rule's prelude; that prelude then
  // began with `@`, and the rule it had swallowed vanished from `applied` AND
  // `unevaluated` alike. A `{ required: false }` lookup read the absence as
  // "nothing declares it" and passed — so `@layer base;` in front of
  // `.isDucked { opacity: 0.55 }` would hide exactly the dimming that test
  // forbids. `@layer` and `@import` also reorder the cascade and pull in other
  // files, neither of which anything here models, so they are refused outright.
  for (const statement of ['@layer base;', '@import url("x.css");', '@charset "utf-8";']) {
    refuses(() => declAt(`${statement}\n.channel { min-width: 46px }`, 360, '.channel', 'min-width'), /statement at-rule/);
    // including the direction that used to PASS: an absence read as a null
    refuses(
      () => declAt(`${statement}\n.isDucked { opacity: 0.55 }`, 360, '.isDucked', 'opacity', { required: false }),
      /statement at-rule/,
    );
  }
  // `@layer name { … }` with a block is still the ordinary unevaluated path
  refuses(
    () => declAt(`@layer base { .channel { min-width: 150px } }\n.channel { min-width: 46px }`, 360, '.channel', 'min-width'),
    /cannot\s+evaluate/,
  );
});

test('resolver: refuses CSS nesting rather than parsing a selector as a declaration', () => {
  refuses(() => declAt(`.a { gap: 1px; &:hover { gap: 9px } }`, 360, '.a', 'gap'), /nested rules/);
});

test('resolver: the shapes that already failed closed still do', () => {
  // Round 3 got these right and round 4 confirmed all four. They are pinned so
  // the widening above cannot quietly turn one of them into an answer.
  const cases = [
    ['@media nested in @supports', `@supports (display: flex) { @media (min-width: 0px) { .channel { min-width: 150px } } }\n.channel { min-width: 46px }`],
    ['range syntax', `@media (400px <= width <= 800px) { .channel { min-width: 150px } }\n.channel { min-width: 46px }`],
    ['negated media query', `@media not all and (min-width: 760px) { .channel { min-width: 150px } }\n.channel { min-width: 46px }`],
    ['an unknown media feature', `@media (orientation: portrait) { .channel { min-width: 150px } }\n.channel { min-width: 46px }`],
  ];
  for (const [what, css] of cases) {
    refuses(() => declAt(css, 360, '.channel', 'min-width'), /cannot\s+evaluate/);
    assert.ok(what);
  }
  // a `var()` FALLBACK CHAIN is not resolved either — `px()` refuses it
  refuses(() => px('var(--a, var(--b, 16px))'), /cannot resolve/);
  refuses(() => px('calc(16px + 2px)'), /cannot resolve/);
});

test('the page gutter is declared in exactly one file, which is what makes pageGutter() safe', () => {
  // NEW HOLE, never stated: the resolver reads ONE FILE AT A TIME and models
  // no cross-file source order. `pageGutter()` is sound today only because
  // `--sl-gutter` has exactly one declaring file; a second declaration
  // anywhere would make "last wins" depend on an import order this file cannot
  // see, and the gate would answer confidently from whichever file it read.
  // So the invariant is asserted rather than assumed.
  const roots = ['src/styles', 'src/components', 'src/app'];
  const files = [];
  const walkDir = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(WEB, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walkDir(next);
      else if (entry.name.endsWith('.css')) files.push(next);
    }
  };
  for (const root of roots) walkDir(root);
  assert.ok(files.length >= 3, `expected a real stylesheet tree, found ${files.length}`);
  const declaring = files.filter((f) => /--sl-gutter\s*:/.test(uncomment(read(f))));
  assert.deepEqual(
    declaring,
    [TOKENS_CSS],
    `--sl-gutter must be declared in exactly one file for pageGutter() to be resolvable ` +
      `without cross-file source order, which this resolver does not model`,
  );
});

// The widest stem label, MEASURED IN CHROMIUM in real Inter at --text-sm /
// --weight-semibold / uppercase, and written down here as a literal. It is the
// one number in the budget below that does NOT come from the stylesheets, and
// that is the point: a gate that resolves every term from the same source it is
// checking proves only that the source agrees with itself.
//
//   "VOCALS", --tracking-normal (the phone cascade) -> 45.25px
//   "VOCALS", --tracking-wide   (from 760px up)     -> 48.25px
//
// 48 is the ceiling of the wider of the two, and it also clears the OTHER floor
// in one number: the 44px fader hit column plus the channel's two 1px borders.
const LABEL_FLOOR_PX = 48;

test('six channels fit at 360px and three fit below it, against the measured label floor', () => {
  const css = read(MIXER_CSS);
  const at = (selector, prop, width = NARROWEST) => declAt(css, width, selector, prop);
  const channels = PLAYABLE_STEMS.length;

  // The rail is a grid now, so the column count is the thing to read and the
  // channel has no width floor of its own to disagree with it.
  const cols = (width) => {
    const value = at('.rail', 'grid-template-columns', width);
    const m = value.match(/^repeat\(\s*(\d+)\s*,/);
    assert.ok(m, `cannot read a column count from \`${value}\``);
    return Number(m[1]);
  };
  assert.equal(cols(NARROWEST), channels, 'six across at 360');
  assert.equal(cols(1024), channels, 'six across on a laptop');
  assert.equal(cols(320), 3, 'three across below 360, not a horizontal scroller');

  // …and all six are still rendered at that width. Three across is a second
  // row, never five channels and a scrollbar.
  const html = render({ stems: allReady(), onGain() {}, onMute() {}, onSolo() {} });
  for (const name of PLAYABLE_STEMS) {
    assert.match(html, new RegExp(`data-stem="${name}"`), `${name} is not rendered`);
  }

  // What a 360px viewport leaves the rail, inside the page gutter and the
  // mixer's own border and padding. Every term resolved at 360.
  const gutter = pageGutter();
  const mixerPad = px(at('.mixer', 'padding'));
  const mixerBorder = px(at('.mixer', 'border').split(/\s+/)[0]);
  // `gap` is `<row> <column>`; the column gap is what the width budget spends.
  const columnGap = (width) => {
    const parts = at('.rail', 'gap', width).trim().split(/\s+/);
    assert.equal(parts.length, 2, `expected \`gap: <row> <column>\`, got \`${parts.join(' ')}\``);
    return px(parts[1], width);
  };
  const colGap = columnGap(NARROWEST);
  const available = NARROWEST - 2 * gutter - 2 * mixerBorder - 2 * mixerPad;
  const required = channels * LABEL_FLOOR_PX + (channels - 1) * colGap;
  assert.ok(
    required <= available,
    `${channels} channels need ${required}px (${LABEL_FLOOR_PX}px each, measured) but only ` +
      `${available}px is available at ${NARROWEST}px ` +
      `(gutter ${gutter}, border ${mixerBorder}, padding ${mixerPad}, column-gap ${colGap})`,
  );

  // Below the breakpoint, three across has to fit the NARROWEST phone we claim
  // to support. 320px viewport, same chain.
  const narrowAvail = 320 - 2 * pageGutter(320) - 2 * mixerBorder - 2 * px(at('.mixer', 'padding', 320));
  const narrowReq = 3 * LABEL_FLOOR_PX + 2 * columnGap(320);
  assert.ok(narrowReq <= narrowAvail, `three channels need ${narrowReq}px of ${narrowAvail}px at 320px`);

  // and the channel is still wide enough to hold the full 44px fader column
  const touch = px('var(--touch-min)');
  assert.equal(px(at('.fader', 'width')), touch);
  assert.ok(
    LABEL_FLOOR_PX >= touch + 2,
    `a ${LABEL_FLOOR_PX}px channel cannot hold a ${touch}px fader plus its borders`,
  );

  // THE BREAKPOINT ITSELF. Stated as a literal so moving it is deliberate, and
  // checked against the budget above rather than against itself: at 360 six
  // channels must fit, and the rule must hand over to three BELOW that.
  assert.match(
    uncomment(css),
    /@media \(max-width: 359px\)/,
    'the three-across rule must hand over immediately below 360',
  );
});

test('stem names are not tracked out of their own channel on phones', () => {
  const css = read(MIXER_CSS);
  // At ~48px per channel, --tracking-wide made VOCALS need 48px of a 47px box
  // and it ellipsised to "VOCA…". Nothing here can measure a glyph, but the
  // tracking this depends on is a declared value and can be pinned.
  assert.equal(declAt(css, NARROWEST, '.name', 'letter-spacing'), 'var(--tracking-normal)');
  assert.equal(declAt(css, 1024, '.name', 'letter-spacing'), 'var(--tracking-wide)');
});

test('a muted stem DIMS and still shows its level; it does not vanish and is not anonymised', () => {
  // Found by mutation: deleting the dimming rule left the suite green while a
  // muted guitar rendered at full-strength teal, identical to an unmuted stem
  // (verified in Chromium, not inferred -- `color(srgb 0.18 0.77 0.71 / 0.34)`
  // with the rule gone against `color(srgb 0.096 0.249 0.235)` with it).
  const css = read(MIXER_CSS);
  const at = (selector, prop) => declAt(css, NARROWEST, selector, prop);

  // 1. the figure dims, and dims to the STEM'S OWN hue -- a muted channel is
  //    still identifiably guitar rather than a generic grey box
  const wave = at('.isMuted .wave > span', 'background');
  assert.match(wave, /color-mix\(/, 'a muted stem must be dimmed, not left at full strength');
  assert.match(wave, /var\(--stem/, 'and must keep its own hue, so the channel is not anonymous');

  // 2. the painted column dims the same way…
  const track = at('.isMuted .fader::-webkit-slider-runnable-track', 'background');
  assert.match(track, /color-mix\(/);
  assert.match(track, /var\(--stem/);

  // 3. …but the LEVEL survives the dimming. This is the substantive property:
  //    the gradient stop is still the live value, so a user can read where the
  //    fader is set while it is silenced and know what unmuting returns to.
  //    A rule that dimmed by painting the whole track one flat colour would
  //    pass 1 and 2 and fail here.
  const stops = track.match(/var\(--mx-fill[^)]*\)/g) ?? [];
  assert.equal(stops.length, 2, `the muted track must still be a two-stop gradient at --mx-fill`);
  assert.equal(at('.isMuted .fader::-moz-range-progress', 'background').includes('color-mix('), true);

  // 4. and nothing that dims a muted channel may touch its TEXT. The note turns
  //    red and the name is struck through; neither is faded, and no opacity is
  //    put on the channel.
  for (const selector of ['.isMuted', '.isMuted .name', '.isMuted .note']) {
    assert.equal(
      declAt(css, NARROWEST, selector, 'opacity', { required: false }),
      null,
      `${selector} fades text that still has to be read`,
    );
  }
});

test('ducking recedes the LEVEL, never the words: no opacity on the channel itself', () => {
  const css = read(MIXER_CSS);
  // `opacity: 0.55` on the channel put a ducked channel's note at 2.52:1 and
  // its name at 2.79:1 against a 4.5:1 floor — on up to five channels that are
  // still live and still interactive. Nothing may dim the channel as a whole.
  for (const channelLevel of ['.isDucked', '.isDucked:not(.isMuted)']) {
    assert.equal(
      declAt(css, NARROWEST, channelLevel, 'opacity', { required: false }),
      null,
      `${channelLevel} dims the whole channel, text included`,
    );
  }
  // the fader column carries the signal instead, and the note still says why
  // `forced-colors` is pinned because this stylesheet restates the dimming
  // there: unpinned, the lookup refuses rather than picking one side.
  assert.equal(
    declAt(css, NARROWEST, '.isDucked:not(.isMuted) .slot', 'opacity', {
      env: { forcedColors: 'none' },
    }),
    '0.55',
  );
  assert.equal(declAt(css, NARROWEST, '.isDucked:not(.isMuted) .note', 'font-style'), 'italic');
  // forced colours drop the tint, so the dimming is restated away there
  assert.equal(declForcedColors(css, NARROWEST, '.isDucked:not(.isMuted) .slot', 'opacity'), '1');
});

test('M and S are real touch targets at EVERY width: stacked, and --touch-min on both axes', () => {
  const css = read(MIXER_CSS);
  const narrow = (selector, prop) => declAt(css, NARROWEST, selector, prop);
  const touch = px('var(--touch-min)');

  // Stacked, so each button gets the channel's whole width rather than half of
  // it. Side by side in a ~49px channel they measured 19x40.
  assert.equal(narrow('.toggles', 'flex-direction'), 'column');
  assert.equal(narrow('.toggles', 'padding-inline'), '0');
  assert.equal(px(narrow('.toggle', 'min-height')), touch);
  // min-height, not height: the box may grow but never shrink under the target.
  assert.equal(declAt(css, NARROWEST, '.toggle', 'height', { required: false }), null);

  // border-box is what keeps `width: 100%` + padding from overflowing the rail.
  assert.equal(narrow('.note', 'box-sizing'), 'border-box');
  assert.equal(narrow('.toggles', 'box-sizing'), 'border-box');

  // ONE ARRANGEMENT AT EVERY WIDTH. These used to go back to a row from 760px
  // up, which is two layouts to learn for a pair you reach for without looking.
  // Resolved AT each width, so a rule that leaves the block it is supposed to
  // be in fails here rather than matching some other block's declaration.
  // Stacked at 1280/1440 each button is 141.66 x 44px, hand-measured in
  // Chromium -- there is no width problem to solve by lying them down.
  for (const width of [320, 359, 360, 759, 760, 1024, 1440]) {
    assert.equal(declAt(css, width, '.toggles', 'flex-direction'), 'column', `at ${width}px`);
    assert.equal(
      declAt(css, width, '.toggle', 'height', { required: false }),
      null,
      `a fixed height at ${width}px can shrink the target below ${touch}px`,
    );
    assert.equal(px(declAt(css, width, '.toggle', 'min-height'), width), touch, `at ${width}px`);
  }
  assert.equal(declAt(css, NARROWEST, '.fader', 'touch-action'), 'none');
});

// ═══ The comment-stripping instruments, pinned ══════════════════════════════
//
// Every source-text gate in this file is only as good as these two functions,
// and `uncomment` used to be a one-line regex with four holes. Each case below
// is a shape that regex got wrong.

test('uncomment: blanks comments, keeps code, strings and line numbers', () => {
  const css = 'a { x: 1; } /* slider-vertical\n  still comment */ b { y: 2; }';
  const out = uncomment(css);
  assert.equal(out.length, css.length, 'columns are preserved');
  assert.equal(out.split('\n').length, css.split('\n').length, 'line numbers are preserved');
  assert.doesNotMatch(out, /slider-vertical|still/);
  assert.match(out, /a \{ x: 1; \}\s+b \{ y: 2; \}/);
});

test('uncomment: an UNTERMINATED comment runs to end of file, as CSS Syntax says', () => {
  const out = uncomment('a { x: 1; }\n/* appearance: slider-vertical;\n.b { c: d; }');
  assert.doesNotMatch(out, /slider-vertical/, 'the old regex left this live');
  assert.doesNotMatch(out, /\.b/);
  assert.match(out, /a \{ x: 1; \}/);
});

test('uncomment: `/*` inside a string or an unquoted url() is not a comment', () => {
  const inString = uncomment('a { content: "/*"; } .real { appearance: none; } /* gone */');
  assert.match(inString, /\.real \{ appearance: none; \}/, 'the old regex swallowed this rule');
  assert.doesNotMatch(inString, /gone/);
  const inUrl = uncomment('a { background: url(x/*y*/z.png); } .after { w: 1; }');
  assert.match(inUrl, /url\(x\/\*y\*\/z\.png\)/);
  assert.match(inUrl, /\.after/);
});

test('uncomment: a comment between tokens does not fuse them', () => {
  assert.doesNotMatch(uncomment('a/**/b { x: 1 }'), /\bab\b/);
});

test('uncommentTs: blanks // and /* */ comments but not `//` in strings, templates or JSX text', () => {
  const src = [
    'const a = "http://example.com"; // slider-vertical in a line comment',
    'const b = `//not a comment ${a}`;',
    '/* block with key={i} */',
    'export const X = () => <p>see http://x.test, don\'t // panic{/* jsx comment key={i} */}</p>;',
  ].join('\n');
  const out = uncommentTs(src);
  assert.equal(out.length, src.length);
  assert.doesNotMatch(out, /slider-vertical|block with|jsx comment/);
  assert.match(out, /"http:\/\/example\.com"/);
  assert.match(out, /`\/\/not a comment/);
  assert.match(out, /see http:\/\/x\.test, don't \/\/ panic/);
});

// ═══ Design-system coupling ══════════════════════════════════════════════════

test('every styles.* the component uses is defined in Mixer.module.css', () => {
  const used = new Set([...uncommentTs(read(MIXER_TSX)).matchAll(/styles\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const css = uncomment(read(MIXER_CSS));
  const defined = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(used.size >= 10, `expected a real class list, got ${used.size}`);
  for (const name of used) assert.ok(defined.has(name), `styles.${name} has no CSS rule`);
});

test('the stylesheet reuses the locked tokens and invents no second palette', () => {
  const css = uncomment(read(MIXER_CSS));
  for (const token of ['--stem', '--bg-card', '--text-secondary', '--touch-min', '--radius-md', '--space-2', '--accent', '--status-failed']) {
    assert.ok(css.includes(`var(${token}`), `expected ${token}`);
  }
  // no raw hex colours: every colour comes from a token
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], `raw hex in the stylesheet: ${hex.join(', ')}`);
  // reduced motion and forced colours are handled, as elsewhere in the repo
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

test('the component takes MixerProps and does not reach for the engine', () => {
  // scan the CODE, not the prose: the header comment legitimately names these.
  const code = uncommentTs(read(MIXER_TSX));
  assert.match(code, /type MixerProps/);
  assert.match(code, /effectivelySilent/); // renders from it
  assert.ok(code.includes('MixerProps'), 'comment stripping ate the code');
  for (const forbidden of ['AudioContext', 'GainNode', 'PlayEngine', 'setGain(', 'getSnapshot', 'subscribe(']) {
    assert.ok(!code.includes(forbidden), `Mixer must not touch ${forbidden}`);
  }
});

// ═══ Review findings 3, 4 and 5 ══════════════════════════════════════════════
//
// These are the defects an independent review of #184 reproduced in a real
// browser. Each one is asserted here on the code path that produced it: the
// class list for 3 and 4 (computed at render, so renderToStaticMarkup really
// does execute it) and the restore/write state machine for 5 (pure, so it runs
// in full). The measured numbers behind them — the 360px boxes and the note's
// contrast ratio — are in the PR description; this file cannot measure a box.

test('an absent stem is ABSENT, not silenced: nothing is soloed, so nothing is ducked', () => {
  const rows = Mixer.mixerRows([stem('drums')]);
  const bass = rows.find((row) => row.stem.name === 'bass');
  assert.equal(bass.present, false);
  assert.equal(bass.disabled, true);
  // `effectivelySilent: true` here made silenceReason answer 'solo-elsewhere'
  // with nothing soloed, which dimmed the row to 0.55 and italicised its note.
  assert.equal(bass.stem.effectivelySilent, false);
  assert.equal(bass.silence, null);
  assert.match(bass.unavailableReason, /no audio was loaded/);
});

test('a disabled channel is never ducked, so the sentence saying WHY stays readable', () => {
  // The engine may well report an unavailable stem as silent. Nothing is soloed.
  const html = render({
    stems: [stem('drums'), stem('bass', { availability: 'encode_failed', effectivelySilent: true, gain: 0 })],
    ...handlers(),
  });
  for (const name of ['bass', 'guitar']) { // bass: explicitly failed. guitar: absent.
    const tag = channelTag(html, name);
    assert.match(tag, /isDisabled/, `${name} should be disabled`);
    assert.ok(!/isDucked/.test(tag), `${name} is dimmed to 0.55 while explaining itself`);
  }
  assert.match(noteFor(html, 'bass'), /failed to encode/);
  assert.match(noteFor(html, 'guitar'), /no audio was loaded/);
});

test('a soloed stem the engine reports silent is lifted, and NOT dimmed as well', () => {
  const html = render({
    stems: [
      stem('drums', { soloed: true, effectivelySilent: true }),
      ...['bass', 'guitar', 'keys', 'vocals', 'other'].map((n) => stem(n)),
    ],
    ...handlers(),
  });
  const tag = channelTag(html, 'drums');
  assert.match(tag, /isSoloed/);
  assert.ok(!/isDucked/.test(tag), 'a channel cannot be lifted and dimmed at the same time');
  assert.equal(noteFor(html, 'drums'), 'Silent'); // still named honestly
});

test('ducking still happens where it SHOULD: live, quiet because another stem is soloed', () => {
  const html = render({
    stems: withSilence([
      stem('drums', { soloed: true }),
      ...['bass', 'guitar', 'keys', 'vocals', 'other'].map((n) => stem(n)),
    ]),
    ...handlers(),
  });
  const bass = channelTag(html, 'bass');
  assert.match(bass, /isDucked/, 'the solo-elsewhere treatment was deleted, not narrowed');
  assert.equal(noteFor(html, 'bass'), 'Silent — another stem is soloed');
  const drums = channelTag(html, 'drums');
  assert.match(drums, /isSoloed/);
  assert.ok(!/isDucked/.test(drums));
});

// ─── Finding 5: per-stem restore, and writes that cannot destroy memory ──────

const remembered = (gain, over = {}) => ({ gain, muted: false, soloed: false, ...over });
const rowsFor = (list) => Mixer.mixerRows(list);
const loadingExcept = (ready) =>
  rowsFor(
    PLAYABLE_STEMS.map((n) => (ready.includes(n) ? stem(n) : stem(n, { availability: 'unavailable' }))),
  );

test('memory: a stem is restored the first time IT becomes ready, not once for the whole job', () => {
  const memory = { drums: remembered(0.3), vocals: remembered(0.2) };
  let state = Mixer.beginRestore(memory);

  // ── drums is ready; the other five have not loaded yet ──
  const loading = loadingExcept(['drums']);
  const first = Mixer.planRestore(state, loading);
  state = first.next;
  assert.deepEqual(first.ops, [{ stem: 'drums', gain: 0.3 }]);

  // The write that follows must not bank drums at its PRE-restore level, and
  // must not drop vocals — this is the write that destroyed `vocals: 0.2`.
  const w1 = Mixer.memoryWritePayload(state, loading);
  const m1 = JSON.parse(w1.payload);
  assert.equal(w1.changed, true);
  assert.deepEqual(m1.drums, remembered(0.3));
  assert.deepEqual(m1.vocals, remembered(0.2));
  state = { ...state, memory: w1.memory, written: w1.payload };

  // ── the engine applies the restore, and the rest arrive ready ──
  const all = rowsFor([
    stem('drums', { gain: 0.3 }),
    ...['bass', 'guitar', 'keys', 'vocals', 'other'].map((n) => stem(n)),
  ]);
  const second = Mixer.planRestore(state, all);
  state = second.next;
  assert.deepEqual(second.ops, [{ stem: 'vocals', gain: 0.2 }], 'vocals was never restored');

  const w2 = Mixer.memoryWritePayload(state, all);
  const m2 = JSON.parse(w2.payload);
  assert.equal(m2.drums.gain, 0.3);
  assert.equal(m2.vocals.gain, 0.2, 'vocals was overwritten with its mount-time level');
  assert.equal(m2.bass.gain, 0.8); // a stem with nothing remembered just records itself
  state = { ...state, memory: w2.memory, written: w2.payload };

  // ── and once it has all settled there is nothing left to push ──
  const settled = rowsFor([
    stem('drums', { gain: 0.3 }),
    stem('vocals', { gain: 0.2 }),
    ...['bass', 'guitar', 'keys', 'other'].map((n) => stem(n)),
  ]);
  assert.deepEqual(Mixer.planRestore(state, settled).ops, []);
});

test('memory: a pushed restore is not retired until the snapshot actually moves', () => {
  // The mirror of "never retiring": retiring too EAGERLY is the data-loss
  // direction. A slow engine republishes the PRE-restore snapshot before it has
  // applied anything; if that retires the stem, its live (pre-restore) level is
  // banked over the remembered one and the saved mix is gone.
  const memory = { drums: remembered(0.3) };
  let state = Mixer.beginRestore(memory);
  const rows = rowsFor([stem('drums')]); // ready, still at its mount-time 0.8

  const pushed = Mixer.planRestore(state, rows);
  state = pushed.next;
  assert.deepEqual(pushed.ops, [{ stem: 'drums', gain: 0.3 }]);

  // the engine republishes the same snapshot, unchanged
  const again = Mixer.planRestore(state, rows);
  state = again.next;
  assert.deepEqual(again.ops, [], 'the restore was pushed a second time');

  const { payload } = Mixer.memoryWritePayload(state, rows);
  assert.equal(
    JSON.parse(payload).drums.gain,
    0.3,
    'the pre-restore 0.8 was banked over the remembered 0.3',
  );

  // and it DOES retire the moment the snapshot moves, even to a third value
  const moved = Mixer.planRestore(state, rowsFor([stem('drums', { gain: 0.9 })]));
  assert.equal(
    JSON.parse(Mixer.memoryWritePayload(moved.next, rowsFor([stem('drums', { gain: 0.9 })])).payload)
      .drums.gain,
    0.9,
  );
});

test('memory: a stem that is not ready keeps its remembered level, whatever the snapshot says', () => {
  const memory = { vocals: remembered(0.2) };
  // vocals is PRESENT in the snapshot but unavailable, carrying a default gain.
  const rows = rowsFor([stem('drums'), stem('vocals', { availability: 'unavailable', gain: 0.8 })]);
  const { next } = Mixer.planRestore(Mixer.beginRestore(memory), rows);
  const { payload } = Mixer.memoryWritePayload(next, rows);
  assert.equal(JSON.parse(payload).vocals.gain, 0.2);
});

test('memory: once the engine has answered, the LIVE level is what gets written', () => {
  // Otherwise "never clobber a restore" would also mean "never record a change".
  const memory = { drums: remembered(0.3) };
  let state = Mixer.beginRestore(memory);
  state = Mixer.planRestore(state, loadingExcept(['drums'])).next;
  // The engine answers with a value of its own — it clamped, or the user grabbed
  // the fader before the restore landed. Either way that is now the truth.
  const answered = rowsFor([stem('drums', { gain: 0.9 })]);
  state = Mixer.planRestore(state, answered).next;
  const { payload } = Mixer.memoryWritePayload(state, answered);
  assert.equal(JSON.parse(payload).drums.gain, 0.9);
});

test('memory: a remembered mix that already matches pushes nothing and settles at once', () => {
  const memory = { drums: remembered(0.8) };
  const rows = rowsFor([stem('drums', { gain: 0.8 })]);
  const { next, ops } = Mixer.planRestore(Mixer.beginRestore(memory), rows);
  assert.deepEqual(ops, []);
  // settled immediately, so the live value is authoritative on the very first write
  assert.equal(JSON.parse(Mixer.memoryWritePayload(next, rows).payload).drums.gain, 0.8);
});

test('memory: mute and solo are restored too, not just the fader', () => {
  const memory = { drums: remembered(0.5, { muted: true }), bass: remembered(0.8, { soloed: true }) };
  const rows = rowsFor([stem('drums'), stem('bass')]);
  const { ops } = Mixer.planRestore(Mixer.beginRestore(memory), rows);
  assert.deepEqual(ops, [
    { stem: 'drums', gain: 0.5, muted: true },
    { stem: 'bass', soloed: true },
  ]);
});

test('memory: the payload keys follow PLAYABLE_STEMS, so it compares as a string', () => {
  const rows = rowsFor([...PLAYABLE_STEMS].reverse().map((n) => stem(n)));
  const { next } = Mixer.planRestore(Mixer.beginRestore({}), rows);
  const keys = Object.keys(JSON.parse(Mixer.memoryWritePayload(next, rows).payload));
  assert.deepEqual(keys, [...PLAYABLE_STEMS]);
});

test('readMixerMemory: no window, no storage, no throw', () => {
  assert.deepEqual(Mixer.readMixerMemory('any-job'), {});
});

test('readMixerMemory: reads THIS job\'s key, and never throws on a hostile store', () => {
  // No jsdom here, but `sessionStore()` only needs a `window` with a
  // `sessionStorage` on it, so the real read path can be driven with a stub.
  // Without this, stubbing the whole function to `return {}` passed.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const withStore = (sessionStorage) => {
    globalThis.window = { sessionStorage };
  };
  try {
    const mix = { drums: { gain: 0.25, muted: false, soloed: true } };
    let askedFor = null;
    withStore({
      getItem: (key) => {
        askedFor = key;
        return JSON.stringify(mix);
      },
    });
    assert.deepEqual(Mixer.readMixerMemory('JOB-A'), mix);
    assert.equal(askedFor, Mixer.mixerMemoryKey('JOB-A'), 'read the wrong job');

    withStore({
      getItem: () => {
        throw new Error('blocked');
      },
    });
    assert.deepEqual(Mixer.readMixerMemory('JOB-A'), {});

    withStore({ getItem: () => 'not json {{{' });
    assert.deepEqual(Mixer.readMixerMemory('JOB-A'), {});

    withStore({ getItem: () => JSON.stringify({ drums: { gain: 'x' }, bass: { gain: 1e999 } }) });
    assert.deepEqual(Mixer.readMixerMemory('JOB-A'), {});
  } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globalThis.window;
  }
});

test('memory: writes are skipped while nothing changes, and a NEW job always writes once', () => {
  // The engine republishes every frame while playing, so an unchanged mix must
  // not touch storage. But that cache belongs to one job: carried into the next
  // job it swallowed the first write to the new key whenever the two mixes
  // serialised identically, and the new job was then never remembered at all.
  const rows = rowsFor(PLAYABLE_STEMS.map((n) => stem(n)));
  let state = Mixer.planRestore(Mixer.beginRestore({}), rows).next;

  const first = Mixer.memoryWritePayload(state, rows);
  assert.equal(first.changed, true);
  state = { ...state, memory: first.memory, written: first.payload };

  // same snapshot, republished: nothing to write
  assert.equal(Mixer.memoryWritePayload(state, rows).changed, false);

  // a different job, byte-identical mix: still written, because the state is new
  const nextJob = Mixer.planRestore(Mixer.beginRestore({}), rows).next;
  const again = Mixer.memoryWritePayload(nextJob, rows);
  assert.equal(again.payload, first.payload);
  assert.equal(again.changed, true, 'a new job inherited the previous job\'s write cache');
});

test('memory: beginRestore is the only constructor, and it starts the write cache empty', () => {
  assert.equal(Mixer.beginRestore({}).written, null);
  assert.equal(Mixer.beginRestore({ drums: remembered(0.4) }).written, null);
  // and planRestore carries it through rather than resetting it mid-job — on the
  // step that pushes a restore as well as the step that has nothing to do.
  const rows = rowsFor([stem('drums')]);
  const idle = { ...Mixer.beginRestore({}), written: 'sentinel' };
  assert.equal(Mixer.planRestore(idle, rows).next.written, 'sentinel');
  const pushing = { ...Mixer.beginRestore({ drums: remembered(0.4) }), written: 'sentinel' };
  const step = Mixer.planRestore(pushing, rows);
  assert.deepEqual(step.ops, [{ stem: 'drums', gain: 0.4 }]); // this step really does push
  assert.equal(step.next.written, 'sentinel', 'a restore step reset the write cache');
});
