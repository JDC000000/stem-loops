// THE #212 WIDTH REFERENCE IS THE CI CHROMIUM, and this is what makes that true.
//
// apps/web/test/chord-default-zoom.test.mjs (Node, no layout engine) and the
// headless table in ChordOverlay.helpers.ts (ADVANCE_16PX, ESTIMATE_PAD_PX) run
// on PINNED Chromium widths, now in apps/web/test/fixtures/chord-label-widths.json.
// A pin is only as good as the machine that produced it. This test re-measures
// every pinned number with scripts/measure-chord-label-widths.mjs in the CI job
// that runs this package ("Chord chip fit (real Chromium)", ubuntu-latest, the
// Playwright/Chromium pinned in pnpm-lock.yaml, the GateInter font file) and
// FAILS when a single number differs. So the pins cannot drift from the
// reference silently, and a pin typed by hand cannot pass for a measurement.
//
// It prints the complete measured fixture (on success too) between
// `=== chord-label-widths.json (measured here) ===` markers. If the reference
// itself moved on purpose (a Playwright bump, a runner image whose fallback
// font for ♯/♭ changed, a formatter change), copy THAT block from the CI log
// into the fixture, copy `advance16` into ADVANCE_16PX and
// `alphabet.estimatePadPx` into ESTIMATE_PAD_PX, and say so in the PR. Never
// paste numbers measured on another machine: they are another font.
//
// NOT THE REFERENCE MACHINE. Off CI the fallback font for ♯/♭ is whatever the
// box has (a machine with Inter installed resolves `sans-serif` differently),
// so this test is expected to disagree there. CHORD_WIDTHS_OFF_REFERENCE=1
// turns the comparison into a printed diagnostic for that case. It is REFUSED
// under GitHub Actions: in CI this test always compares.
//
// Exact comparison, by design: both sides are the same instrument rounded to
// 1e-4px, so any difference at all is a different environment or a hand edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { FIXTURE_PATH, WEB, measure } from '../scripts/measure-chord-label-widths.mjs';

const OFF_REFERENCE = process.env.CHORD_WIDTHS_OFF_REFERENCE === '1';
const IN_CI = process.env.GITHUB_ACTIONS === 'true';

/** The parts of the reference that must be identical (the rest is per-run provenance). */
function identity(ref) {
  return {
    playwright: ref.playwright,
    chromium: ref.chromium,
    fontFile: ref.font.file,
    fontSha256: ref.font.sha256,
    containerFamily: ref.font.containerFamily,
    platformFonts: ref.font.platformFonts.map((f) => `${f.postScriptName}:${f.isCustomFont}:${f.glyphCount}`).sort(),
    accidentalsPaintedBy: ref.font.accidentalsPaintedBy.map((f) => `${f.postScriptName}:${f.glyphCount}`).sort(),
    launchArgs: ref.launchArgs,
    fontPx: ref.fontPx,
    fontWeight: ref.fontWeight,
  };
}

test('the escape hatch is not available in CI', () => {
  assert.ok(!(IN_CI && OFF_REFERENCE), 'CHORD_WIDTHS_OFF_REFERENCE is set under GitHub Actions: the reference must be compared in CI');
});

test('every pinned #212 width is what the CI Chromium measures today', async (t) => {
  const pinned = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const got = await measure();
  // Printed on success as well: the CI log is then the evidence of what the
  // reference measured on this run, not only of what it disagreed with.
  const report = () =>
    console.log(`=== chord-label-widths.json (measured here) ===\n${JSON.stringify(got, null, 2)}\n=== end ===`);
  const mismatches = [];
  const cmp = (name, a, b) => {
    try {
      assert.deepEqual(a, b);
    } catch {
      mismatches.push(name);
    }
  };
  cmp('reference identity (Chromium / Playwright / font file / platform fonts)', identity(got.reference), identity(pinned.reference));
  cmp('advance16 (headless table glyph advances)', got.advance16, pinned.advance16);
  cmp('canvas16 (canvas measureText of the pinned labels)', got.canvas16, pinned.canvas16);
  cmp('dom16 (DOM span widths of the pinned labels)', got.dom16, pinned.dom16);
  cmp('alphabet (whole painted alphabet: table under/over, pad, canvas-DOM spread)', got.alphabet, pinned.alphabet);
  // Per-key detail, so the log names the number and not just the section.
  for (const sec of ['advance16', 'canvas16', 'dom16']) {
    for (const k of new Set([...Object.keys(got[sec]), ...Object.keys(pinned[sec])])) {
      if (got[sec][k] !== pinned[sec][k]) console.log(`# ${sec}[${JSON.stringify(k)}]: pinned ${pinned[sec][k]}, measured ${got[sec][k]}`);
    }
  }
  report();
  if (mismatches.length) {
    if (OFF_REFERENCE) {
      t.diagnostic(`off the reference machine (CHORD_WIDTHS_OFF_REFERENCE=1): ${mismatches.join('; ')} differ, as expected`);
      return;
    }
  }
  assert.deepEqual(mismatches, [], 'pinned widths differ from the CI Chromium reference; the measured fixture is printed above');
});

test('the product table IS the fixture: ADVANCE_16PX and ESTIMATE_PAD_PX are the measured ones', async () => {
  // Also asserted in apps/web (no browser needed there); repeated here so the
  // one job that measures also proves the product reads what it measured.
  const pinned = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const h = await import(pathToFileURL(join(WEB, 'src/components/ChordOverlay.helpers.ts')).href);
  assert.deepEqual({ ...h.ADVANCE_16PX }, pinned.advance16);
  assert.equal(h.ESTIMATE_PAD_PX, pinned.alphabet.estimatePadPx);
});
