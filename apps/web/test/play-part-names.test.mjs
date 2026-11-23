// Rename song parts (Phase C C3): device-only storage + the chip strip + the
// player wiring. Pure module imported directly; SectionLoop is transpiled the
// way test/play-sections.test.mjs does (no browser: markup + DOM harness only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  MAX_PART_NAME_LEN, partNamesKey, partNameSlot, sanitizePartName, readPartNames, writePartNames, applyPartNames, collectPartNames, canRenameParts,
} from '../src/lib/play/part-names.ts';
import { nameRegions, NO_RUN } from '../src/lib/play/sections.ts';
import { withDom, setNativeValue } from './helpers/dom.mjs';
import { buildModuleGraph } from './helpers/module-graph.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

const REGIONS = [0, 23.4, 66, 110.2].map((s, i, a) => ({ startSec: s, endSec: a[i + 1] ?? 150 }));
const NAMED = nameRegions(REGIONS);
const DEFAULTS = NAMED.map((n) => n.name);
const TIMES = NAMED.map((n) => n.time);

/** A Map-backed Storage. */
const fakeStorage = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

test('storage round-trip: save, read back, per section start time', () => {
  const st = fakeStorage();
  assert.equal(writePartNames('job-1', { [partNameSlot(REGIONS[1])]: 'Verse', [partNameSlot(REGIONS[3])]: 'Outro' }, st), true);
  const back = readPartNames('job-1', st);
  assert.deepEqual(back, { 23400: 'Verse', 110200: 'Outro' });
  assert.deepEqual(applyPartNames(DEFAULTS, REGIONS, back), ['Part 1', 'Verse', 'Part 3', 'Outro']);
});

test('default fallback: nothing saved, bad JSON, wrong shapes, no storage, throwing storage', () => {
  const st = fakeStorage();
  assert.deepEqual(readPartNames('j', st), {});
  assert.deepEqual(applyPartNames(DEFAULTS, REGIONS, {}), DEFAULTS);
  for (const bad of ['{not json', '[]', '"x"', 'null', '42', '{"23":7,"0":"   "}', '["Intro","Verse"]']) {
    st.m.set(partNamesKey('j'), bad);
    assert.deepEqual(readPartNames('j', st), {}, bad);
  }
  assert.deepEqual(readPartNames('j', null), {});
  assert.equal(writePartNames('j', { 0: 'A' }, null), false);
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); } };
  assert.deepEqual(readPartNames('j', boom), {});
  assert.equal(writePartNames('j', { 0: 'A' }, boom), false);
  // an empty name returns that part to its default and an empty map removes the entry
  writePartNames('j', { 0: 'Intro' }, st);
  writePartNames('j', collectPartNames(['', 'Part 2', '  ', ''], REGIONS, DEFAULTS), st);
  assert.equal(st.m.has(partNamesKey('j')), false);
});

test('max length 24 and trim: spaces trimmed, inner runs collapsed, long names cut, never an empty-looking name', () => {
  assert.equal(MAX_PART_NAME_LEN, 24);
  assert.equal(sanitizePartName('   Big  chorus  '), 'Big chorus');
  assert.equal(sanitizePartName('x'.repeat(40)), 'x'.repeat(24));
  assert.equal(sanitizePartName('a'.repeat(23) + '   zzz'), 'a'.repeat(23));
  assert.equal(sanitizePartName('   '), '');
  assert.equal(sanitizePartName(7), '');
  const st = fakeStorage();
  writePartNames('j', { 0: '  Solo  ', 23400: 'y'.repeat(60) }, st);
  assert.deepEqual(JSON.parse(st.m.get(partNamesKey('j'))), { 0: 'Solo', 23400: 'y'.repeat(24) });
  assert.deepEqual(collectPartNames(['  Hook ', 'Part 2', '', 'z'.repeat(30)], REGIONS, DEFAULTS), { 0: 'Hook', 110200: 'z'.repeat(24) });
});

test('per-job isolation: one job\'s names never show on another', () => {
  const st = fakeStorage();
  writePartNames('job-A', { 0: 'Alpha' }, st);
  writePartNames('job-B', { 0: 'Beta' }, st);
  assert.deepEqual(readPartNames('job-A', st), { 0: 'Alpha' });
  assert.deepEqual(readPartNames('job-B', st), { 0: 'Beta' });
  assert.deepEqual(readPartNames('job-C', st), {});
  assert.notEqual(partNamesKey('job-A'), partNamesKey('job-B'));
  assert.equal(st.m.size, 2);
  assert.deepEqual(readPartNames('', st), {}, 'no job id, no names');
});

// ── the strip ───────────────────────────────────────────────────────────────
let loaded;
async function loadStrip() {
  if (loaded) return loaded;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'part-names-'));
  writeFileSync(join(dir, 'sections.mjs'), toJs(readFileSync(join(WEB, 'src/lib/play/sections.ts'), 'utf8')));
  writeFileSync(join(dir, 'styles.mjs'), 'export default new Proxy({}, { get: (_, k) => String(k) });');
  const js = toJs(readFileSync(join(WEB, 'src/components/play/SectionLoop.tsx'), 'utf8'))
    .replace(/from ['"]@\/lib\/play\/sections['"]/g, "from './sections.mjs'")
    .replace(/from ['"]\.\/SectionLoop\.module\.css['"]/g, "from './styles.mjs'");
  writeFileSync(join(dir, 'SectionLoop.mjs'), js);
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const mod = await import(pathToFileURL(join(dir, 'SectionLoop.mjs')).href);
  loaded = { mod, React, render: (p) => renderToStaticMarkup(React.createElement(mod.SectionLoop, p)) };
  return loaded;
}
const noop = () => {};
const flat = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

test('chip shows the custom name, keeps the start time and the colour; others keep "Part N"', async () => {
  const { render } = await loadStrip();
  const names = applyPartNames(DEFAULTS, REGIONS, { [partNameSlot(REGIONS[1])]: 'Verse' });
  const html = render({ names, times: TIMES, tones: NAMED.map((n) => n.tone), state: NO_RUN, onTap: noop, onLongPress: noop });
  const text = flat(html);
  assert.match(text, /\|Verse\| · \|0:23\|/);
  assert.match(text, /\|Part 1\| · \|0:00\|/);
  assert.match(text, /\|Part 3\| · \|1:06\|/);
  assert.doesNotMatch(text, /Part 2/);
  assert.equal((html.match(/<button/g) || []).length, 4);
  assert.match(html, /Looping|Sections\./, 'legend still names the strip');
  const looping = render({ names, state: { run: { lo: 1, hi: 1 }, on: true }, onTap: noop, onLongPress: noop });
  assert.match(looping, /Looping Verse\./, 'the legend uses the custom name');
});

test('chips with long names stay inside the strip: the name truncates (ellipsis CSS), the time never does', () => {
  const css = readFileSync(join(WEB, 'src/components/play/SectionLoop.module.css'), 'utf8');
  assert.match(css, /\.chip \{ max-width: 100%; \}/);
  assert.match(css, /\.name \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.time \{ flex: none; \}/);
  assert.match(css, /height: var\(--touch-min, 44px\)/);
  assert.match(css, /border-radius: 22px/);
});

test('gestures unchanged with a custom name: tap = jump (onTap), 500 ms hold = loop (onLongPress)', async () => {
  const { mod, React } = await loadStrip();
  assert.equal(mod.LONG_PRESS_MS, 500);
  await withDom(async (dom) => {
    const taps = [];
    const longs = [];
    const names = applyPartNames(DEFAULTS, REGIONS, { [partNameSlot(REGIONS[1])]: 'Verse' });
    await dom.mount(React.createElement(mod.SectionLoop, { names, state: NO_RUN, onTap: (i) => taps.push(i), onLongPress: (i) => longs.push(i) }));
    const chip = dom.findAll('button')[1];
    assert.match(chip.textContent, /Verse/);
    await dom.act(() => chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    assert.deepEqual(taps, [1]);
    await dom.pointer('pointerdown', chip, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.advance(450);
    assert.deepEqual(longs, []);
    await dom.advance(100);
    assert.deepEqual(longs, [1]);
    await dom.pointer('pointerup', chip, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.unmountAll();
  });
});

// ── the player wiring (source-level: PlayerScreen needs effects + a browser) ──
test('player: "Rename parts" is a ⋯ menu item that opens the sheet; chips get the custom names; saves go through part-names', () => {
  const src = readFileSync(join(WEB, 'src/components/play/PlayerScreen.tsx'), 'utf8');
  assert.match(src, /data-testid="menu-rename-parts"[\s\S]{0,200}setRenameOpen\(true\)[\s\S]{0,80}Rename parts/);
  assert.match(src, /applyPartNames\(defaultNames, sections, customNames\)/);
  assert.match(src, /readPartNames\(jobId\)/);
  assert.match(src, /writePartNames\(jobId, next\)/);
  assert.match(src, /<SectionLoop[\s\S]{0,80}names=\{names\}/);
  assert.doesNotMatch(readFileSync(join(WEB, 'src/lib/play/part-names.ts'), 'utf8'), /fetch\(|\/api\//, 'device only: no network, no route');
  const sheet = readFileSync(join(WEB, 'src/components/play/RenameParts.tsx'), 'utf8');
  assert.match(sheet, /maxLength=\{MAX_PART_NAME_LEN\}/);
  assert.match(sheet, /type="submit"[\s\S]{0,120}Save/);
  assert.match(sheet, /onClick=\{onClose\}[\s\S]{0,120}Cancel/);
  const css = readFileSync(join(WEB, 'src/components/play/RenameParts.module.css'), 'utf8');
  assert.equal((css.match(/height: 44px/g) || []).length >= 2, true, 'inputs and buttons are >= 44px');
  assert.doesNotMatch(css, /background: var\(--accent/, 'lime stays the Play button\'s alone (A5)');
  assert.match(css, /\.save \{ background: var\(--bg-selected\); border: 2px solid #fff/);
});

test('a stored ARRAY is rejected (its indexes would land on real slots)', () => {
  const st = fakeStorage();
  st.m.set(partNamesKey('j'), JSON.stringify(['Intro', 'Verse']));
  assert.deepEqual(readPartNames('j', st), {});
  assert.deepEqual(applyPartNames(['Part 1', 'Part 2'], [{ startSec: 0, endSec: 1 }, { startSec: 0.001, endSec: 2 }], readPartNames('j', st)), ['Part 1', 'Part 2']);
});

test('two parts that start in the same second keep separate names (ms key)', () => {
  const two = [{ startSec: 10, endSec: 10.4 }, { startSec: 10.4, endSec: 20 }];
  const d = ['Part 1', 'Part 2'];
  const m = collectPartNames(['Hook', 'Bridge'], two, d);
  assert.equal(Object.keys(m).length, 2);
  assert.deepEqual(applyPartNames(d, two, m), ['Hook', 'Bridge']);
});

test('"Rename parts" is offered only for a playable song with at least one part', () => {
  assert.equal(canRenameParts(true, 3), true);
  assert.equal(canRenameParts(true, 0), false);
  assert.equal(canRenameParts(false, 3), false);
  const src = readFileSync(join(WEB, 'src/components/play/PlayerScreen.tsx'), 'utf8');
  assert.match(src, /canRenameParts\(playable, sections\.length\) \? \([\s\S]{0,200}menu-rename-parts/);
});

test('a failed save is surfaced, not swallowed', () => {
  const src = readFileSync(join(WEB, 'src/components/play/PlayerScreen.tsx'), 'utf8');
  assert.match(src, /const saved = writePartNames\(jobId, next\);[\s\S]{0,200}if \(!saved\) setSetToast\(PART_NAMES_NOT_SAVED\)/);
});

// ── F1: the "+N more" cue is re-measured when a name changes ────────────────
test('strip (DOM): renaming a part re-measures overflow, so the "+N more" cue appears without any scroll or resize', async () => {
  const { mod, React } = await loadStrip();
  await withDom(async (dom) => {
    // Fake layout: a name over 10 chars makes its chip fill a whole row (one chip per row); short names all share row 0.
    const proto = dom.window.Element.prototype;
    const original = proto.getBoundingClientRect;
    const rect = (top, bottom) => ({ top, bottom, left: 0, right: 10, width: 10, height: bottom - top, x: 0, y: top, toJSON() {} });
    proto.getBoundingClientRect = function () {
      if (this.hasAttribute?.('data-index')) {
        const names = [...this.parentElement.querySelectorAll('button[data-index]')].map((b) => b.textContent);
        const wide = names.some((t) => t.length > 12);
        const i = Number(this.getAttribute('data-index'));
        return wide ? rect(i * 52, i * 52 + 44) : rect(4, 48);
      }
      return rect(0, 52); // the list box
    };
    const props = (names) => ({ names, state: NO_RUN, onTap: noop, onLongPress: noop });
    const host = await dom.mount(React.createElement(mod.SectionLoop, props(DEFAULTS)));
    assert.equal(dom.find('[data-testid="section-more"]'), null, 'everything fits before the rename');
    await dom.rerender(host, React.createElement(mod.SectionLoop, props(['Part 1', 'A very long chorus name', 'Part 3', 'Part 4'])));
    const cue = dom.find('[data-testid="section-more"]');
    assert.ok(cue, 'the cue must appear after a rename that pushes chips out of view');
    assert.equal(cue.textContent, '+3 more \u2193');
    await dom.rerender(host, React.createElement(mod.SectionLoop, props(DEFAULTS)));
    assert.equal(dom.find('[data-testid="section-more"]'), null, 'and go away again when the names are short');
    await dom.unmountAll();
    proto.getBoundingClientRect = original;
  });
});

// ── F3: the Rename sheet's behaviour ────────────────────────────────────────
let sheetMod;
async function loadSheet() {
  if (sheetMod) return sheetMod;
  const g = buildModuleGraph({ name: 'rename-parts', entries: ['components/play/RenameParts.tsx'] });
  sheetMod = { ...(await import(g.url('components/play/RenameParts.tsx'))), React: (await import('react')).default };
  return sheetMod;
}

test('rename sheet (DOM): pre-fills custom names only; edits do NOT save; Save passes every field; Cancel discards', async () => {
  const { RenameParts, React } = await loadSheet();
  await withDom(async (dom) => {
    const saves = [];
    let closed = 0;
    const current = ['Part 1', 'Verse', 'Part 3', 'Part 4'];
    const el = () => React.createElement(RenameParts, { open: true, onClose: () => closed++, defaults: DEFAULTS, current, times: TIMES, onSave: (d) => saves.push(d) });
    await dom.mount(el());
    const inputs = dom.findAll('input[type="text"]');
    assert.equal(inputs.length, 4);
    assert.deepEqual(inputs.map((i) => i.value), ['', 'Verse', '', ''], 'a default name is an empty field, a custom one is filled');
    assert.ok(inputs.every((i) => i.getAttribute('maxlength') === '24'));
    assert.deepEqual(inputs.map((i) => i.getAttribute('placeholder')), DEFAULTS);
    // typing saves nothing
    await dom.act(async () => { setNativeValue(inputs[0], 'Intro'); });
    await dom.act(async () => { setNativeValue(inputs[1], ''); });
    assert.deepEqual(saves, [], 'nothing is saved per keystroke');
    // Save submits every field, in order
    const form = dom.find('[data-testid="rename-parts-form"]');
    await dom.act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(saves, [['Intro', '', '', '']]);
    // Cancel closes without saving
    saves.length = 0;
    await dom.act(async () => { setNativeValue(dom.findAll('input[type="text"]')[2], 'Typed then cancelled'); });
    await dom.act(async () => { dom.find('[data-testid="rename-parts-cancel"]').click(); });
    assert.equal(closed, 1);
    assert.deepEqual(saves, []);
    await dom.unmountAll();
  });
});

test('rename sheet (DOM): reopening starts from the saved names, not the discarded draft', async () => {
  const { RenameParts, React } = await loadSheet();
  await withDom(async (dom) => {
    const base = { onClose: () => {}, defaults: DEFAULTS, current: DEFAULTS, times: TIMES, onSave: () => {} };
    const host = await dom.mount(React.createElement(RenameParts, { ...base, open: true }));
    await dom.act(async () => { setNativeValue(dom.findAll('input[type="text"]')[0], 'Draft'); });
    await dom.rerender(host, React.createElement(RenameParts, { ...base, open: false }));
    await dom.rerender(host, React.createElement(RenameParts, { ...base, open: true }));
    assert.deepEqual(dom.findAll('input[type="text"]').map((i) => i.value), ['', '', '', '']);
    await dom.unmountAll();
  });
});
