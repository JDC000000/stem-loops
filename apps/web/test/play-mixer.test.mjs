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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
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
  const css = read(MIXER_CSS);
  assert.match(css, /writing-mode:\s*vertical-lr/);
  assert.match(css, /-webkit-appearance:\s*slider-vertical/);
  assert.match(css, /direction:\s*rtl/); // zero at the bottom
  assert.doesNotMatch(css, /transform:\s*rotate/); // hit area must follow the paint
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
  assert.match(css, /\.isMuted \.name\s*\{[^}]*line-through/);
  assert.equal(declAt(css, NARROWEST, '.isDucked:not(.isMuted) .slot', 'opacity'), '0.55');
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
  const src = read(MIXER_TSX);
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
// box, so an overflow caused by something the arithmetic does not model — a
// padded descendant, a scrollbar — still passes. What it IS is arithmetic over
// values that are every one of them READ, never restated, and read from the
// CASCADE THAT APPLIES AT 360px rather than from the base cascade.
//
// Both halves of that sentence were learned the hard way. A first version
// hard-coded the page gutter as `16` and the mixer border as `2` while
// claiming to track them. A second version resolved them but threw every
// `@media` block away, so a `@media (max-width: 759px)` override of the gutter
// or the channel floor — the same idiom this stylesheet uses in the other
// direction — was invisible, and the suite stayed green while the rail
// overflowed by 16px and by 44px and the sixth channel's Solo button sat
// outside the viewport entirely, unclickable.

const TOKENS_CSS = 'src/styles/design-tokens.css';

/** The narrowest viewport the mixer promises to fit every channel in. */
const NARROWEST = 360;

/** Comments can contain braces; strip them before counting any. */
const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every style rule that applies at `width`, in source order, separated from
 * the ones this file cannot evaluate.
 *
 * `@media` blocks are kept when their width conditions hold at `width` and
 * dropped when they do not, so what comes back is the cascade that renders
 * there. Anything whose condition cannot be evaluated here — a non-width
 * `@media`, `@supports`, `@layer` — goes to `unevaluated` rather than being
 * guessed at, and `declAt` fails loudly if one of those touches a value it was
 * asked for. Failing closed is the point: a silent wrong answer is what put a
 * launch-blocking layout defect through this gate twice.
 */
const DEFAULT_ENV = {
  width: 360,
  forcedColors: 'none',
  reducedMotion: 'no-preference',
  colorScheme: 'dark',
};

const rulesAt = (css, env) => {
  const { width, forcedColors, reducedMotion, colorScheme } = { ...DEFAULT_ENV, ...env };
  const applied = [];
  const unevaluated = [];

  /**
   * true / false / null ("cannot tell") for one at-rule prelude in `env`.
   * The non-width features are evaluated too rather than shrugged at, because
   * "I cannot tell" on `forced-colors` would make this refuse to answer any
   * question about a property that file also sets in a forced-colors block.
   */
  const holds = (prelude) => {
    const WIDTH = /\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)/g;
    const FEATURE = /\(\s*(forced-colors|prefers-reduced-motion|prefers-color-scheme)\s*:\s*([a-z-]+)\s*\)/g;
    const widths = [...prelude.matchAll(WIDTH)];
    const features = [...prelude.matchAll(FEATURE)];
    const leftover = prelude
      .replace(WIDTH, '')
      .replace(FEATURE, '')
      .replace(/@media|\band\b|\bonly\b|\bscreen\b|\ball\b|[\s,]/g, '');
    if (leftover.length > 0 || widths.length + features.length === 0) return null;
    const env_ = {
      'forced-colors': forcedColors,
      'prefers-reduced-motion': reducedMotion,
      'prefers-color-scheme': colorScheme,
    };
    return (
      widths.every(([, kind, n]) => (kind === 'min' ? width >= Number(n) : width <= Number(n))) &&
      features.every(([, name, want]) => env_[name] === want)
    );
  };

  const walk = (text, state) => {
    let i = 0;
    for (;;) {
      const brace = text.indexOf('{', i);
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
          decls: body,
        });
      }
      i = j + 1;
    }
  };

  walk(uncomment(css), 'applied');
  return { applied, unevaluated };
};

/**
 * The winning value of `selector { prop }` at `width` — LAST declaration wins,
 * the way the cascade resolves it, not the first one in the file. Only rules
 * whose selector list contains `selector` exactly are consulted, so
 * `.isMuted .name` never answers a question about `.name`.
 */
const declAt = (css, width, selector, prop, { required = true, env = {} } = {}) => {
  const { applied, unevaluated } = rulesAt(css, { ...env, width });
  const winner = (rules) => {
    let found = null;
    for (const rule of rules) {
      if (!rule.selectors.includes(selector)) continue;
      const hits = [...rule.decls.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))];
      if (hits.length > 0) found = hits[hits.length - 1][1].trim();
    }
    return found;
  };
  const blind = winner(unevaluated);
  assert.equal(
    blind,
    null,
    `\`${selector} { ${prop} }\` is set to \`${blind}\` inside an at-rule this test cannot ` +
      `evaluate — teach rulesAt about it rather than trusting the base value`,
  );
  const value = winner(applied);
  if (required) assert.ok(value !== null, `nothing declares \`${prop}\` for \`${selector}\` at ${width}px`);
  return value;
};

/** The same lookup in forced-colors mode, where this stylesheet restates states. */
const declForcedColors = (css, width, selector, prop, opts = {}) =>
  declAt(css, width, selector, prop, { ...opts, env: { forcedColors: 'active' } });

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

test('every channel fits at 360px, with each number resolved from the stylesheets', () => {
  const css = read(MIXER_CSS);
  const at = (selector, prop) => declAt(css, NARROWEST, selector, prop);
  const gutter = pageGutter();
  const channelMin = px(at('.channel', 'min-width'));
  const railGap = px(at('.rail', 'gap'));
  const mixerPad = px(at('.mixer', 'padding'));
  const mixerBorder = px(at('.mixer', 'border').split(/\s+/)[0]);
  const channels = PLAYABLE_STEMS.length;

  // What a 360px viewport actually leaves the rail, inside the page gutter and
  // the mixer's own border and padding.
  const available = NARROWEST - 2 * gutter - 2 * mixerBorder - 2 * mixerPad;
  const required = channels * channelMin + (channels - 1) * railGap;
  assert.ok(
    required <= available,
    `${channels} channels need ${required}px but only ${available}px is available at ` +
      `${NARROWEST}px (gutter ${gutter}, border ${mixerBorder}, padding ${mixerPad})`,
  );

  // and the channel is still wide enough to hold the full 44px fader column
  const touch = px('var(--touch-min)');
  assert.equal(px(at('.fader', 'width')), touch);
  assert.ok(
    channelMin >= touch + 2,
    `a ${channelMin}px channel cannot hold a ${touch}px fader plus its borders`,
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
  assert.equal(declAt(css, NARROWEST, '.isDucked:not(.isMuted) .slot', 'opacity'), '0.55');
  assert.equal(declAt(css, NARROWEST, '.isDucked:not(.isMuted) .note', 'font-style'), 'italic');
  // forced colours drop the tint, so the dimming is restated away there
  assert.equal(declForcedColors(css, NARROWEST, '.isDucked:not(.isMuted) .slot', 'opacity'), '1');
});

test('M and S are real touch targets on phones: stacked, and --touch-min on both axes', () => {
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

  // From 760px up there is width for a row again — resolved AT 1024px, so a
  // rule that leaves the breakpoint it is supposed to be in fails here rather
  // than matching some other block's `flex-direction: row`. And it is still a
  // row at exactly 760, the boundary.
  for (const wide of [760, 1024]) {
    assert.equal(declAt(css, wide, '.toggles', 'flex-direction'), 'row', `at ${wide}px`);
    assert.equal(px(declAt(css, wide, '.toggle', 'height'), wide), touch, `at ${wide}px`);
  }
  // …and still stacked at 759, the width below it
  assert.equal(declAt(css, 759, '.toggles', 'flex-direction'), 'column');
  assert.match(css, /touch-action:\s*none/);
});

// ═══ Design-system coupling ══════════════════════════════════════════════════

test('every styles.* the component uses is defined in Mixer.module.css', () => {
  const used = new Set([...read(MIXER_TSX).matchAll(/styles\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const css = read(MIXER_CSS);
  const defined = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(used.size >= 10, `expected a real class list, got ${used.size}`);
  for (const name of used) assert.ok(defined.has(name), `styles.${name} has no CSS rule`);
});

test('the stylesheet reuses the locked tokens and invents no second palette', () => {
  const css = read(MIXER_CSS);
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
  const src = read(MIXER_TSX);
  assert.match(src, /type MixerProps/);
  assert.match(src, /effectivelySilent/); // renders from it
  // scan the CODE, not the prose: the header comment legitimately names these.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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
