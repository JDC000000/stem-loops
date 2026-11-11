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
  // and the stylesheet really gives them different treatments
  const css = read(MIXER_CSS);
  assert.match(css, /\.isMuted \.name\s*\{[^}]*line-through/);
  assert.match(css, /\.isDucked:not\(\.isMuted\)\s*\{[^}]*opacity/);
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

test('hit targets are generous: 44px fader column, 40px+ toggles, and no scroll hijack', () => {
  const css = read(MIXER_CSS);
  assert.match(css, /\.fader\s*\{[\s\S]*?width:\s*var\(--touch-min\)/);
  assert.match(css, /\.toggle\s*\{[\s\S]*?height:\s*40px/);
  assert.match(css, /height:\s*var\(--touch-min\)/); // >=760px
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
