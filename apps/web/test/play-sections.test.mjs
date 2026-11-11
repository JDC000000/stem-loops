// Section looping (Story 4.5): deriveSections() and the SectionLoop control.
//
// sections.ts is pure and imported directly (strip-types). There is NO DOM
// harness in this repo (no jsdom / testing-library), so SectionLoop.tsx is
// transpiled with the TypeScript compiler (as test/helpers/render-login-form.mjs
// does) and exercised two ways: renderToStaticMarkup for what the user sees, and
// by calling the component function and invoking the onClick/onKeyDown props it
// returns. That proves the handlers emit the right regions; it is NOT a browser
// test (no real focus, click or CSS), and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  deriveSections, sanitizeRegions, sameRegion, nextLoop, formatTime, nameRegions, normalizeLabel,
} from '../src/lib/play/sections.ts';

// ─── fixtures: the shape of a real production job ───────────────────────────
// 60 loops, 6 stems, bpm 82.5, C major, track 142.6 s. One 4-bar loop is
// 4 * 4 * 60 / 82.5 = 11.636 s, so the song is 12 positional segments. Each stem
// carries 10 of the 12 (2 dropped, different per stem), and `numeric` columns
// arrive from node-pg as strings.
const BPM = 82.5;
const TRACK_SEC = 142.6;
const LOOP_SEC = (4 * 4 * 60) / BPM;
const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const SEG_LABELS = [
  'intro', 'verse', 'verse', 'chorus', 'chorus', 'verse',
  'verse', 'chorus', 'chorus', 'bridge', 'outro', 'outro',
];
// Expected musical sections, as segment index ranges [from, toExclusive).
const EXPECTED = [
  ['intro', 0, 1], ['verse', 1, 3], ['chorus', 3, 5], ['verse', 5, 7],
  ['chorus', 7, 9], ['bridge', 9, 10], ['outro', 10, 12],
];
const at = (i) => Math.round(i * LOOP_SEC * 1000) / 1000;

function loopRow(stem, seg, over = {}) {
  return {
    id: `${stem}-${seg}`, job_id: 'job-1', stem,
    section_label: SEG_LABELS[seg], energy_class: 'mid',
    start_sec: String(i2s(seg)), end_sec: String(i2s(seg + 1)),
    start_bar: seg * 4, bar_count: 4, bpm: '82.5', musical_key: 'C major',
    r2_key: `job-1/${stem}/${seg}.wav`, filename: `${stem}_${seg}.wav`, ...over,
  };
}
function i2s(i) { return i * LOOP_SEC; } // full precision, as the DB would hold it

function realJob() {
  const rows = [];
  STEMS.forEach((stem, k) => {
    for (let seg = 0; seg < 12; seg++) {
      if (seg === k || seg === k + 6) continue; // this stem lost 2 segments
      rows.push(loopRow(stem, seg));
    }
  });
  return rows;
}

const expectedRegions = () => EXPECTED.map(([label, a, b]) => ({ label, startSec: at(a), endSec: at(b) }));
const shape = (rs) => rs.map((r) => ({ label: r.label, startSec: r.startSec, endSec: r.endSec }));
const row = (label, s, e) => ({ section_label: label, start_sec: s, end_sec: e });

test('fixture really is 60 loops across 6 stems on a 142.6 s track', () => {
  const rows = realJob();
  assert.equal(rows.length, 60);
  assert.equal(new Set(rows.map((r) => r.stem)).size, 6);
  assert.ok(12 * LOOP_SEC < TRACK_SEC);
  assert.equal(typeof rows[0].start_sec, 'string'); // pg numeric -> string
});

// ─── R5 / R6: six stems collapse to one set of musical sections ─────────────
test('six stems x 10 loops collapse to the 7 musical sections, not 60 rows', () => {
  const out = deriveSections(realJob(), { durationSec: TRACK_SEC });
  assert.deepEqual(shape(out), expectedRegions());
});

test('result does not depend on row order (DB returns ORDER BY stem, start_sec)', () => {
  const rows = realJob();
  const reversed = [...rows].reverse();
  const shuffled = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1) * ((a.id.length % 3) - 1 || 1));
  assert.deepEqual(deriveSections(reversed), deriveSections(rows));
  assert.deepEqual(deriveSections(shuffled), deriveSections(rows));
});

test('a single stem alone yields the same sections wherever it has coverage', () => {
  const drums = realJob().filter((r) => r.stem === 'drums'); // lost segments 0 and 6
  const out = deriveSections(drums);
  assert.equal(out[0].label, 'verse'); // intro (seg 0) is missing for this stem
  assert.ok(out.length >= 5);
});

// ─── R6: two choruses are two regions ───────────────────────────────────────
test('two separate choruses stay two regions, with the verse between them untouched', () => {
  const out = deriveSections(realJob());
  const choruses = out.filter((r) => r.label === 'chorus');
  assert.equal(choruses.length, 2);
  assert.ok(choruses[0].endSec < choruses[1].startSec);
  const between = out.filter((r) => r.startSec >= choruses[0].endSec && r.endSec <= choruses[1].startSec);
  assert.equal(between.length, 1);
  assert.equal(between[0].label, 'verse');
});

test('consecutive same-label loops form ONE region (chorus is a section, not four loops)', () => {
  const out = deriveSections([row('chorus', 0, 10), row('chorus', 10, 20), row('chorus', 20, 30), row('chorus', 30, 40)]);
  assert.deepEqual(shape(out), [{ label: 'chorus', startSec: 0, endSec: 40 }]);
});

test('same label with a real gap between is two regions, even with nothing in the gap', () => {
  const out = deriveSections([row('chorus', 0, 10), row('chorus', 20, 30)]);
  assert.equal(out.length, 2);
});

test('same label separated by a different label is two regions', () => {
  const out = deriveSections([row('chorus', 0, 10), row('verse', 10, 20), row('chorus', 20, 30)]);
  assert.deepEqual(out.map((r) => r.label), ['chorus', 'verse', 'chorus']);
});

// ─── R1: labels ─────────────────────────────────────────────────────────────
test('null, undefined, empty, blank and non-string labels are ignored, not thrown on', () => {
  const rows = [
    row(null, 0, 10), row(undefined, 0, 10), row('', 0, 10), row('   ', 0, 10), row(42, 0, 10),
    row('verse', 10, 20),
  ];
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'verse', startSec: 10, endSec: 20 }]);
});

test('a job with no section labels at all returns [] cleanly', () => {
  const rows = realJob().map((r) => ({ ...r, section_label: null }));
  assert.deepEqual(deriveSections(rows), []);
  assert.deepEqual(deriveSections(realJob().map((r) => ({ ...r, section_label: '' }))), []);
});

test('labels differing only by case or whitespace are the same section', () => {
  const out = deriveSections([row('Chorus', 0, 10), row(' chorus ', 10, 20), row('CHORUS', 20, 30), row('chor\tus'.replace('\t', ''), 30, 40)]);
  assert.deepEqual(shape(out), [{ label: 'chorus', startSec: 0, endSec: 40 }]);
  assert.equal(normalizeLabel('  Pre   Chorus '), 'pre chorus');
  assert.deepEqual(deriveSections([row('Pre  Chorus', 0, 5), row('pre chorus', 5, 10)]).length, 1);
});

test('60 identically-labelled rows are one region', () => {
  const rows = Array.from({ length: 60 }, (_, i) => row('chorus', (i % 6) * 0 + 0, 23.272));
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'chorus', startSec: 0, endSec: 23.272 }]);
  const tiled = Array.from({ length: 60 }, (_, i) => row('verse', i * 2, i * 2 + 2));
  assert.deepEqual(shape(deriveSections(tiled)), [{ label: 'verse', startSec: 0, endSec: 120 }]);
});

// ─── empty / degenerate input ───────────────────────────────────────────────
test('empty, null and non-array input return []', () => {
  assert.deepEqual(deriveSections([]), []);
  assert.deepEqual(deriveSections(null), []);
  assert.deepEqual(deriveSections(undefined), []);
  assert.deepEqual(deriveSections('nope'), []);
  assert.deepEqual(deriveSections({ length: 3 }), []);
});

test('a single loop is a single region', () => {
  assert.deepEqual(shape(deriveSections([row('intro', 0, 11.636)])), [{ label: 'intro', startSec: 0, endSec: 11.636 }]);
});

test('null / non-object rows inside the array are skipped', () => {
  assert.deepEqual(deriveSections([null, undefined, 7, 'x', row('verse', 0, 5)]).length, 1);
});

// ─── R2 / R3: bad times ─────────────────────────────────────────────────────
test('rows with end <= start, NaN, Infinity, or missing times never produce a region', () => {
  const rows = [
    row('verse', 10, 10), row('verse', 20, 10), row('verse', NaN, 5), row('verse', 0, Infinity),
    row('verse', null, 5), row('verse', 0, undefined), row('verse', 'abc', 'def'), row('verse', '', ''),
  ];
  assert.deepEqual(deriveSections(rows), []);
});

test('a backwards row cannot lend phantom coverage to the rows around it', () => {
  const rows = [row('verse', 20, 10), row('verse', 25, 12), row('chorus', 0, 30)];
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'chorus', startSec: 0, endSec: 30 }]);
});

test('numeric strings from pg are coerced; blank string is not 0', () => {
  assert.deepEqual(shape(deriveSections([row('verse', '11.636', '23.272')])), [{ label: 'verse', startSec: 11.636, endSec: 23.272 }]);
  assert.deepEqual(deriveSections([row('verse', '', '5')]), []);
});

test('a region longer than the track is clamped to it; one starting past the end is dropped', () => {
  const out = deriveSections([row('outro', 130, 500), row('bridge', 200, 300)], { durationSec: TRACK_SEC });
  assert.deepEqual(shape(out), [{ label: 'outro', startSec: 130, endSec: TRACK_SEC }]);
  assert.ok(out.every((r) => r.endSec <= TRACK_SEC));
});

test('without a duration nothing is clamped; a nonsense duration is ignored', () => {
  assert.equal(deriveSections([row('outro', 130, 500)])[0].endSec, 500);
  for (const d of [0, -5, NaN, Infinity]) assert.equal(deriveSections([row('outro', 130, 500)], { durationSec: d })[0].endSec, 500);
});

test('negative start is clamped to 0', () => {
  assert.deepEqual(shape(deriveSections([row('intro', -3, 8)])), [{ label: 'intro', startSec: 0, endSec: 8 }]);
  assert.deepEqual(deriveSections([row('intro', -8, -3)]), []);
});

// ─── R4: float noise ────────────────────────────────────────────────────────
test('boundaries that differ by float noise are one boundary, not a sliver region', () => {
  const out = deriveSections([row('verse', 0, 11.636), row('verse', 11.6360004, 23.272), row('chorus', 23.2719996, 34.908)]);
  assert.deepEqual(out.map((r) => r.label), ['verse', 'chorus']);
  assert.equal(out[0].endSec, out[1].startSec);
});

test('stems that disagree on a boundary by <50 ms still give clean, abutting regions', () => {
  const out = deriveSections([
    row('verse', 0, 11.636), row('verse', 0.01, 11.64), row('chorus', 11.62, 23.27), row('chorus', 11.65, 23.3),
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.endSec - r.startSec > 10));
});

test('a boundary gap of more than 50 ms is real and keeps two regions', () => {
  assert.equal(deriveSections([row('verse', 0, 10), row('verse', 10.2, 20)]).length, 2);
});

// ─── R5: overlap resolution ─────────────────────────────────────────────────
test('stems that disagree on a label: the majority wins over the dissenter', () => {
  const rows = [
    ...['drums', 'bass', 'guitar', 'keys', 'vocals'].map(() => row('chorus', 0, 20)),
    row('verse', 0, 20),
  ];
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'chorus', startSec: 0, endSec: 20 }]);
});

test('a dissenting stem on only half the span flips only that half', () => {
  const rows = [row('verse', 0, 20), row('verse', 0, 20), row('chorus', 10, 20), row('chorus', 10, 20), row('chorus', 10, 20)];
  assert.deepEqual(shape(deriveSections(rows)), [
    { label: 'verse', startSec: 0, endSec: 10 },
    { label: 'chorus', startSec: 10, endSec: 20 },
  ]);
});

test('an exact tie is resolved deterministically (alphabetical), independent of row order', () => {
  const a = deriveSections([row('verse', 0, 10), row('chorus', 0, 10)]);
  const b = deriveSections([row('chorus', 0, 10), row('verse', 0, 10)]);
  assert.deepEqual(a, b);
  assert.equal(a[0].label, 'chorus');
});

test('a tie keeps the label already running rather than flickering', () => {
  const rows = [row('verse', 0, 20), row('chorus', 10, 20)]; // 1 vs 1 on [10,20)
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'verse', startSec: 0, endSec: 20 }]);
});

test('overlapping rows with the same label merge into one region', () => {
  assert.deepEqual(shape(deriveSections([row('verse', 0, 15), row('verse', 10, 25)])), [{ label: 'verse', startSec: 0, endSec: 25 }]);
});

// ─── R7: output invariants ──────────────────────────────────────────────────
function assertWellFormed(out) {
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i].startSec) && Number.isFinite(out[i].endSec));
    assert.ok(out[i].endSec > out[i].startSec, `region ${i} has end <= start`);
    assert.ok(out[i].startSec >= 0);
    if (i > 0) assert.ok(out[i].startSec >= out[i - 1].endSec, `region ${i} overlaps the previous`);
    if (i > 0) assert.ok(out[i].startSec >= out[i - 1].startSec, 'not sorted by startSec');
  }
}

test('output is sorted by startSec with no overlaps (real job)', () => {
  assertWellFormed(deriveSections(realJob(), { durationSec: TRACK_SEC }));
});

test('output stays sorted/non-overlapping under adversarial random input', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const labels = ['intro', 'Verse', ' verse', 'chorus', 'bridge', 'outro', '', null];
  for (let t = 0; t < 200; t++) {
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => {
      const s = rnd() * 150 - 5;
      return row(labels[Math.floor(rnd() * labels.length)], s, s + rnd() * 40 - 3);
    });
    assertWellFormed(deriveSections(rows, { durationSec: 142.6 }));
  }
});

test('deriveSections does not mutate its input', () => {
  const rows = realJob();
  const before = JSON.stringify(rows);
  deriveSections(rows);
  assert.equal(JSON.stringify(rows), before);
});

// ─── helpers the component relies on ────────────────────────────────────────
test('sanitizeRegions drops end<=start, NaN and negative starts; clamps; sorts; de-dupes', () => {
  const out = sanitizeRegions([
    { startSec: 30, endSec: 40, label: 'b' }, { startSec: 5, endSec: 5 }, { startSec: 9, endSec: 3 },
    { startSec: NaN, endSec: 3 }, { startSec: -1, endSec: 3 }, { startSec: 0, endSec: 10, label: 'a' },
    { startSec: 0.004, endSec: 10.004, label: 'dup' }, { startSec: 140, endSec: 900, label: 'long' },
    { startSec: 200, endSec: 300, label: 'past' }, null,
  ], TRACK_SEC);
  assert.deepEqual(out.map((r) => r.label), ['a', 'b', 'long']);
  assert.equal(out[2].endSec, TRACK_SEC);
  assert.deepEqual(sanitizeRegions(null), []);
  assert.deepEqual(sanitizeRegions('x'), []);
});

test('sanitizeRegions without a duration still rejects zero-length and backwards regions', () => {
  assert.deepEqual(sanitizeRegions([{ startSec: 5, endSec: 5 }, { startSec: 9, endSec: 3 }]), []);
  assert.equal(sanitizeRegions([{ startSec: 5, endSec: 5.001 }]).length, 1);
});

test('a loop shorter than the 50 ms snap window cannot create or erase a region', () => {
  assert.deepEqual(deriveSections([row('verse', 10, 10.02)]), []);
  assert.deepEqual(shape(deriveSections([row('verse', 0, 20), row('chorus', 10, 10.02)])), [{ label: 'verse', startSec: 0, endSec: 20 }]);
});

test('sameRegion compares spans with tolerance and ignores labels; null is never same', () => {
  assert.ok(sameRegion({ startSec: 1, endSec: 2, label: 'a' }, { startSec: 1.005, endSec: 2, label: 'b' }));
  assert.ok(!sameRegion({ startSec: 1, endSec: 2 }, { startSec: 1.5, endSec: 2 }));
  assert.ok(!sameRegion({ startSec: 1, endSec: 2 }, { startSec: 1, endSec: 2.5 }));
  assert.ok(!sameRegion(null, null));
  assert.ok(!sameRegion({ startSec: 1, endSec: 2 }, null));
});

test('nextLoop: clicking the active region clears it, another region selects it', () => {
  const a = { startSec: 0, endSec: 10, label: 'verse' };
  const b = { startSec: 10, endSec: 20, label: 'chorus' };
  assert.equal(nextLoop(a, a), null);
  assert.equal(nextLoop(a, b), b);
  assert.equal(nextLoop(null, a), a);
});

test('formatTime renders m:ss and survives bad input', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(59.9), '0:59');
  assert.equal(formatTime(142.6), '2:22');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-4), '0:00');
});

test('nameRegions numbers repeated labels and leaves unique ones plain', () => {
  const names = nameRegions(deriveSections(realJob())).map((n) => n.name);
  assert.deepEqual(names, ['Intro', 'Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro']);
  assert.deepEqual(nameRegions([{ startSec: 0, endSec: 1 }]).map((n) => n.name), ['Section']);
});

// ─── the component ──────────────────────────────────────────────────────────
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

let loaded;
async function loadComponent() {
  if (loaded) return loaded;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'section-loop-'));
  writeFileSync(join(dir, 'sections.mjs'), toJs(readFileSync(join(WEB, 'src/lib/play/sections.ts'), 'utf8')));
  // CSS modules: class name = key, so markup assertions read naturally.
  writeFileSync(join(dir, 'styles.mjs'), 'export default new Proxy({}, { get: (_, k) => String(k) });');
  const js = toJs(readFileSync(join(WEB, 'src/components/play/SectionLoop.tsx'), 'utf8'))
    .replace(/from ['"]@\/lib\/play\/sections['"]/g, "from './sections.mjs'")
    .replace(/from ['"]\.\/SectionLoop\.module\.css['"]/g, "from './styles.mjs'");
  writeFileSync(join(dir, 'SectionLoop.mjs'), js);
  const { renderToStaticMarkup } = await import('react-dom/server');
  const mod = await import(pathToFileURL(join(dir, 'SectionLoop.mjs')).href);
  loaded = { SectionLoop: mod.SectionLoop, render: (p) => renderToStaticMarkup(mod.SectionLoop(p)) };
  return loaded;
}

// Walk the element tree the component returns and collect <button> elements.
function buttons(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => buttons(n, out)); return out; }
  if (node.type === 'button') out.push(node);
  buttons(node.props && node.props.children, out);
  return out;
}
const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'object' ? textOf(n.props && n.props.children) : String(n));

const SECTIONS = deriveSections(realJob(), { durationSec: TRACK_SEC });

test('component: one real <button> per section, each with an explicit aria-pressed', async () => {
  const { SectionLoop, render } = await loadComponent();
  const html = render({ sections: SECTIONS, active: null, onLoop() {} });
  const bs = buttons(SectionLoop({ sections: SECTIONS, active: null, onLoop() {} }));
  assert.equal(bs.length, SECTIONS.length + 1); // + Clear
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, SECTIONS.length);
  assert.ok(!html.includes('aria-pressed="true"'));
  assert.ok(bs.every((b) => b.props.type === 'button'));
  assert.ok(html.includes('Chorus 1') && html.includes('Chorus 2'));
  assert.ok(html.includes('Not looping'));
});

test('component: the active section is pressed, badged and announced; the others are not', async () => {
  const { render } = await loadComponent();
  const html = render({ sections: SECTIONS, active: SECTIONS[2], onLoop() {} });
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.ok(html.includes('Looping</span>')); // text badge, not colour alone
  assert.ok(html.includes('Looping Chorus 1, 0:34 to 0:58'));
  assert.ok(!/class="clear"[^>]*disabled/.test(html));
});

test('component: clicking a section calls onLoop(region); clicking it again calls onLoop(null)', async () => {
  const { SectionLoop } = await loadComponent();
  const calls = [];
  const onLoop = (r) => calls.push(r);
  let bs = buttons(SectionLoop({ sections: SECTIONS, active: null, onLoop }));
  bs[2].props.onClick();
  assert.deepEqual(calls, [SECTIONS[2]]);
  bs = buttons(SectionLoop({ sections: SECTIONS, active: SECTIONS[2], onLoop }));
  bs[2].props.onClick();
  assert.equal(calls[1], null);
  bs[3].props.onClick(); // a different section while one is active switches to it
  assert.deepEqual(calls[2], SECTIONS[3]);
});

test('component: Clear loop calls onLoop(null) and is disabled when nothing is looping', async () => {
  const { SectionLoop } = await loadComponent();
  const calls = [];
  const idle = buttons(SectionLoop({ sections: SECTIONS, active: null, onLoop: (r) => calls.push(r) }));
  assert.equal(idle[idle.length - 1].props.disabled, true);
  const live = buttons(SectionLoop({ sections: SECTIONS, active: SECTIONS[0], onLoop: (r) => calls.push(r) }));
  const clear = live[live.length - 1];
  assert.equal(clear.props.disabled, false);
  assert.equal(textOf(clear), 'Clear loop');
  clear.props.onClick();
  assert.deepEqual(calls, [null]);
});

test('component: Escape inside the control clears an active loop; other keys do nothing', async () => {
  const { SectionLoop } = await loadComponent();
  const calls = [];
  const tree = SectionLoop({ sections: SECTIONS, active: SECTIONS[1], onLoop: (r) => calls.push(r) });
  let prevented = false;
  tree.props.onKeyDown({ key: 'a', preventDefault() { prevented = true; } });
  assert.deepEqual(calls, []);
  tree.props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.deepEqual(calls, [null]);
  assert.ok(prevented);
  const idle = SectionLoop({ sections: SECTIONS, active: null, onLoop: (r) => calls.push(r) });
  idle.props.onKeyDown({ key: 'Escape', preventDefault() {} });
  assert.equal(calls.length, 1); // nothing to clear -> no call
});

test('component: `active` that is not one of `sections` marks nothing pressed but is announced and clearable', async () => {
  const { SectionLoop, render } = await loadComponent();
  const stray = { startSec: 3.3, endSec: 7.7 };
  const html = render({ sections: SECTIONS, active: stray, onLoop() {} });
  assert.ok(!html.includes('aria-pressed="true"'));
  assert.ok(html.includes('Looping custom region, 0:03 to 0:07'));
  const calls = [];
  const bs = buttons(SectionLoop({ sections: SECTIONS, active: stray, onLoop: (r) => calls.push(r) }));
  assert.equal(bs[bs.length - 1].props.disabled, false);
  bs[bs.length - 1].props.onClick();
  assert.deepEqual(calls, [null]);
});

test('component: with no sections offered, a stray active loop is still shown and clearable', async () => {
  const { SectionLoop, render } = await loadComponent();
  const stray = { startSec: 12, endSec: 24 };
  assert.ok(render({ sections: [], active: stray, onLoop() {} }).includes('Looping custom region, 0:12 to 0:24'));
  const calls = [];
  const bs = buttons(SectionLoop({ sections: [], active: stray, onLoop: (r) => calls.push(r) }));
  assert.equal(bs.length, 1);
  bs[0].props.onClick();
  assert.deepEqual(calls, [null]);
});

test('component: hostile sections never render a button or emit an invalid region', async () => {
  const { SectionLoop, render } = await loadComponent();
  const hostile = [
    { startSec: 10, endSec: 10, label: 'zero' }, { startSec: 20, endSec: 5, label: 'backwards' },
    { startSec: NaN, endSec: 5, label: 'nan' }, { startSec: -4, endSec: 5, label: 'neg' },
    null, undefined, { startSec: 0, endSec: 9999, label: 'huge' }, { startSec: 500, endSec: 600, label: 'past' },
  ];
  const calls = [];
  const bs = buttons(SectionLoop({ sections: hostile, active: null, onLoop: (r) => calls.push(r), durationSec: TRACK_SEC }));
  assert.equal(bs.length, 2); // 'huge' (clamped) + Clear
  bs[0].props.onClick();
  assert.deepEqual(calls, [{ startSec: 0, endSec: TRACK_SEC, label: 'huge' }]);
  const html = render({ sections: hostile, active: null, onLoop() {}, durationSec: TRACK_SEC });
  assert.ok(!/zero|backwards|nan|neg|past/i.test(html.replace(/not looping/i, '')));
});

test('component: no sections and no active renders nothing; bad `sections` does not throw', async () => {
  const { render } = await loadComponent();
  assert.equal(render({ sections: [], active: null, onLoop() {} }), '');
  assert.equal(render({ sections: null, active: null, onLoop() {} }), '');
  assert.equal(render({ sections: [{ startSec: 5, endSec: 1 }], active: null, onLoop() {} }), '');
});

test('component: 60 identically-labelled rows through deriveSections give one button', async () => {
  const { SectionLoop } = await loadComponent();
  const one = deriveSections(Array.from({ length: 60 }, () => row('chorus', 0, 23.272)));
  assert.equal(buttons(SectionLoop({ sections: one, active: null, onLoop() {} })).length, 2);
});
