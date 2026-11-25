// Pure pairing for scripts/measure-chord-sync-latency.mjs (US 3.4 / V3-J3). No browser, no I/O:
// unit tested by test/chord-sync-pairing.test.mjs.
//
// #378 item 1: pairing by clock alone mis-paired one Detailed row (offline, ~179 s): `G` was shown
// ~141 ms late, after `G:maj7`'s start had passed, and the clock rule gave the `G` change to the
// `G:maj7` start. A DOM change is now paired with an expected change only when BOTH hold:
//
//   CLOCK  the expected start is at or before the shown position (rawPos - route compensation, the
//          position the overlay draws) and no more than `windowMs` before it, and it comes after the
//          last expected change already paired (pairing is in order);
//   TEXT   the observed text equals the expected change's displayed text.
//
// THE TEXT RULE, precisely. `expected[i].text` is the label the stage draws for that run in that mode:
// leadSheetSymbol({ kind: classifyLabel(label), label }) from apps/web (ChordPhone.helpers.ts, the one
// formatter both the phone stage and the wide playhead bar use; "G:maj7" -> "Gmaj7", "N" -> "N.C."),
// applied to the run's label AFTER the mode's display layer: the raw segments in Detailed, the
// production simplifier's runs in Simple. The caller computes it in the page with the bundled
// production modules. The observed text is the `playhead-now-name` element's textContent (the phone
// stage splits a slash chord over two block spans with no separator, so textContent is the whole
// symbol). Both sides are compared after String() and trim(), otherwise exactly.
//
// Simple mode: expected changes are the runs whose DISPLAYED text differs from the run before, not
// whose label differs, so a simplifier triad label ("G") next to a raw one ("G:maj") that draws the
// same "G" is not an expected change: the DOM text does not change there, and counting it would be a
// false miss.

/** The stage's "no chord sounding" placeholder (and an absent element). Never a chord text. */
export const PLACEHOLDER_TEXTS = new Set(['—', '']);

/** Default clock window: an expected start more than this before the shown position is not a candidate. */
export const PAIR_WINDOW_MS = 2000;

const norm = (t) => (t === null || t === undefined ? '' : String(t).trim());

/**
 * Expected display changes: the start of every run whose displayed text differs from the run before it.
 * `runs`: [{ startSec, label, text }] in time order, `text` as above (falls back to `label` if absent).
 */
export function expectedStarts(runs) {
  const t = (r) => norm(r.text ?? r.label);
  return runs
    .map((r, i) => ({ start: r.startSec, label: r.label, text: t(r), i }))
    .filter((r, k) => k > 0 && r.text !== t(runs[k - 1]));
}

/**
 * Pair DOM changes with expected changes on clock AND text (see the header).
 *
 * expected: [{ start, label, text }] sorted by start (expectedStarts output).
 * events:   [{ text, rawPos, comp, ct, ctxOut, perf, ctxPerf, rafPerf? }] in observation order.
 *
 * Returns
 *   rows             paired changes with their lags (ms);
 *   misses           expected changes nothing was paired with (reported, never dropped);
 *   spurious         indices of events paired with nothing (the "extras");
 *   textMismatches   the extras that had a clock candidate but whose text matched none in the window
 *                    (placeholder texts excluded: the end-of-song dash is not a mismatch);
 *   pairedBehindClock rows paired with an earlier change than the clock-only rule would have picked
 *                    (the #378 shape: a chord shown so late that the next change's start had passed).
 */
export function pairChanges(expected, events, { extraMs = 0, windowMs = PAIR_WINDOW_MS } = {}) {
  const rows = [];
  const spurious = [];
  const textMismatches = [];
  let pairedBehindClock = 0;
  const used = new Set();
  let floor = -1;
  events.forEach((e, n) => {
    const heardPos = e.rawPos - (e.ct - e.ctxOut - (e.perf - e.ctxPerf) / 1000);
    const heardOk = Number.isFinite(heardPos) && e.ctxPerf > 0;
    const shownPos = e.rawPos - (e.comp ?? 0);
    const text = norm(e.text);
    let clockK = -1;
    let k = -1;
    for (let i = expected.length - 1; i > floor; i--) {
      const x = expected[i];
      if (x.start > shownPos) continue;
      if ((shownPos - x.start) * 1000 > windowMs) break;
      if (clockK < 0) clockK = i;
      if (x.text === text) { k = i; break; }
    }
    if (k < 0) {
      spurious.push(n);
      if (clockK >= 0 && !PLACEHOLDER_TEXTS.has(text)) {
        textMismatches.push({ event: n, text, nearestExp: clockK, nearestText: expected[clockK].text, nearestStart: expected[clockK].start });
      }
      return;
    }
    if (k !== clockK) pairedBehindClock++;
    used.add(k);
    floor = k;
    const sTime = expected[k].start;
    rows.push({
      exp: k, label: expected[k].label, expText: expected[k].text, start: sTime, event: n, text,
      lag_render: (e.rawPos - sTime) * 1000,
      lag_heard: heardOk ? (heardPos - sTime) * 1000 : null,
      lag_heard_route: heardOk ? (heardPos - sTime) * 1000 - extraMs : null,
      comp_ms: (e.comp ?? 0) * 1000,
      raf_after_ms: e.rafPerf ? e.rafPerf - e.perf : null,
    });
  });
  const misses = expected
    .map((x, i) => ({ ...x, i }))
    .filter((x) => !used.has(x.i))
    .map((x) => ({ exp: x.i, label: x.label, text: x.text, start: x.start }));
  return { rows, misses, spurious, textMismatches, pairedBehindClock, expected: expected.length };
}
