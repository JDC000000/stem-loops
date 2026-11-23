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
  MAX_PART_NAME_LEN, partNamesKey, partNameSlot, sanitizePartName, readPartNames, writePartNames, applyPartNames, collectPartNames,
} from '../src/lib/play/part-names.ts';
import { nameRegions, NO_RUN } from '../src/lib/play/sections.ts';
import { withDom } from './helpers/dom.mjs';

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
  assert.deepEqual(back, { 23: 'Verse', 110: 'Outro' });
  assert.deepEqual(applyPartNames(DEFAULTS, REGIONS, back), ['Part 1', 'Verse', 'Part 3', 'Outro']);
});

test('default fallback: nothing saved, bad JSON, wrong shapes, no storage, throwing storage', () => {
  const st = fakeStorage();
  assert.deepEqual(readPartNames('j', st), {});
  assert.deepEqual(applyPartNames(DEFAULTS, REGIONS, {}), DEFAULTS);
  for (const bad of ['{not json', '[]', '"x"', 'null', '42', '{"23":7,"0":"   "}']) {
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
  writePartNames('j', { 0: '  Solo  ', 23: 'y'.repeat(60) }, st);
  assert.deepEqual(JSON.parse(st.m.get(partNamesKey('j'))), { 0: 'Solo', 23: 'y'.repeat(24) });
  assert.deepEqual(collectPartNames(['  Hook ', 'Part 2', '', 'z'.repeat(30)], REGIONS, DEFAULTS), { 0: 'Hook', 110: 'z'.repeat(24) });
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
  const names = applyPartNames(DEFAULTS, REGIONS, { 23: 'Verse' });
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
    const names = applyPartNames(DEFAULTS, REGIONS, { 23: 'Verse' });
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
  assert.equal((css.match(/background: var\(--accent\)[;\s]/g) || []).length, 1, 'lime on ONE control: Save');
  assert.match(css, /\.save \{ background: var\(--accent\)/);
});
