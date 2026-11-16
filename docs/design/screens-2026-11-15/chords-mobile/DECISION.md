# Chords on phones: decision note (2026-11-15, revised after review)

**Problem (Jon, on a phone):** "it's really hard to see them. You just see a whole large list of different chords. You don't know where you're at. They should be streaming by or expanded. It has to be more clear, especially chords when you have two chords in one bar."
**Stories:** 3 (see the chords go by, a marker on the current chord, auto-follow, legible from the playing position, current chord at least 20px) and 4.8 (big sections; keep the chord-root hues).

## Reference products (described, nothing copied)
- **Moises** (help centre: "How to use the new Chords view — Grid Mode" and "How do I use Chord Detection?"): mobile has a *bar mode* (a strip of chords in sync with playback) and a *grid mode* that "shows the song's full structure, with chords synced to bars and beats", with sections in the same view.
- **Chordify** (Music Mark resource page; app store screens): an *animated view* aligned with playback, plus a chord overview or grid as the alternative.
- What they have in common, and what we lacked: chords sit on **bars and beats**, and one chord is clearly *the* current one.

## Candidates
The fixture is synthetic: 96 bpm, 4/4, 100 bars, with two-chord bars (2+2 and 3+1). Screenshots are at 390×844 and 360×800, with and without `prefers-reduced-motion`. The `A-*`, `B-*` and `C-*` files are the candidates as first built. The `shipped-*` files are C as revised below.

| | Layout | Files |
|---|---|---|
| A | **Streaming lane.** Bars slide past a fixed playhead; a "Now" readout sits below. | `A-lane-*.png` |
| B | **Bar grid.** 4 bars per row, auto-scrolled, with "Follow playback". | `B-grid-*.png` |
| C | **Now/Next card and two lines of four bars.** The card shows the current chord at 44px, the next chord and its beat count, and the beat dots. A split bar is one cell. The lines page; nothing moves continuously. | `C-focus-*.png` |

## Scores: three independent Opus reviews of `3bf20a8`
| Lens | A lane | B grid | C focus |
|---|---|---|---|
| Legibility at arm's length (review 1) | 72 | 64 | **86** |
| "Where am I" (review 2) | 71 | 74 | **81** |
| Accessibility, motion and correctness (review 3) | 58 | 70 | **78** |
| **Average** | 67.0 | 69.3 | **81.7** |

The builder's own first-pass scores (76.7 / 79.0 / 92.0) were too generous and are superseded.

All three reviewers chose **C** as the right design, but **C as first built failed** the >90 bar. This revision fixes every must-fix they raised, listed below. It has **not** been re-scored by the independent reviewers yet.

## What changed in C after the reviews (all must-fixes)
| Finding | Fix |
|---|---|
| Bar 76's Bb, a 1-beat chord in a 3+1 bar, rendered blank. Split names were down to 11px. Names in 4-chord bars and long names were blank. | `layoutLine` widens any chord whose name would not fit, taking width from chords that have spare. The fallbacks are, in order: two rows of two bars, then a cell that stacks its chords one per row, then a name that wraps. **A name is never blank and never below 14px.** The fixture now has a 4-chord bar with C#m7b5/G#. |
| The gate checked only the bar under the playhead. | The gate now sweeps **every bar** of the song at both widths. Every visible chord in both lines is checked for: a name, its own spelling, ≥14px, not clipped, label-in-name, and contrast ≥4.5:1. |
| With no tempo, the view showed invented beats. Bars were also drawn on a poor fit and on 3/4 songs. | The view draws bars only when the grid **fits the chords**: ≥70% of chord-time starts on a beat, the downbeat wins by 1.5× or more, and there are at least 4 changes. Otherwise it shows a **plain chord sequence**: one cell per chord, with no beat dots, no "in N beats", no bar numbers and no splits. |
| Tempo drift | The grid is **re-anchored at every section** (the worker snaps section starts to beats). Each section gets its own beat, so drift is bounded to one section. |
| "Next" ignored the section loop. | With a loop playing, Next shows "Loop back to" and the chord at the loop start, and the next line is the loop's first line. |
| Lines started at the pickup bar. | Lines never cross a section, so every section starts on a new line. Loop and section edges snap to the nearest bar line. |
| "Next" in a gap in the chord data showed the song's first chord. | The search starts from the playhead. It also skips N and repeats of the chord already sounding. |
| "bar 55" was an absolute count, and bar numbers could be negative. | The card now reads **"Chorus 2 · bar 3/16"**: numbered per section and 1-based. Silent count-in and tail bars are not drawn. |
| Contrast | The current chord is on L30 (≥5.0:1 on every hue), others on L26 (≥6.2:1). Bar numbers sit in their own strip above the chords (≥4.5:1). Inactive beat dots are at α .5 (≥3:1). |
| ARIA | `aria-current` is set on the current bar and on the current chord. Each bar is `role=group`, labelled "Bar 3 of 16, Chorus 2". A chord's accessible name **starts with its visible text** ("Em7 (E:min7), 2 beats — edit"). There is no `aria-live`. |
| Tests | There are 21 unit tests for the new helpers in `ChordPhone.helpers.ts` and `beatGridFromLoops`. The Chromium gate covers the sweep, the loop, the gap, no tempo and 3/4. All **27 mutants** were each seen to fail it, including the 8 that survived the old gate. The #212 chip-fit gate and the #274 size gate are unchanged and green. |

Not done (should-fix, not must-fix):
- tap-to-seek, with editing on a long press;
- folding "All chords" behind a disclosure on phones;
- ping-pong rows, so the current bar never moves on screen;
- per-bar section labels for sections that start mid-bar (the edges snap to the nearest bar line).

## Desktop
Desktop is unchanged. The phone view renders only under `NARROW_BREAKPOINT_PX` (560px). Review 3 diffed the desktop DOM against the base at 1280px and 820px, and it was identical.
