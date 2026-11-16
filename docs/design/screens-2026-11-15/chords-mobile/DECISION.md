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

## Re-review at `1c09f22` (combined Opus review 4): 87 / 86 / 87, FAIL on 3 blockers, now fixed
| Blocker | Fix |
|---|---|
| **A song with two chords in EVERY bar fell back to the plain list**, which is exactly Jon's complaint. The downbeat test read the beat 1 / beat 3 tie as an odd meter. | The test now **pairs beats**: it compares chord-time starting on beats 1+3 with beats 2+4, and requires a 1.5× margin. A tie inside the winning pair is a half-bar ambiguity, not an odd meter, and it is settled by the first chord after silence. The sequence fallback is now used only when the grid itself is unreliable: no tempo, a poor fit, an even spread over all four beats (3/4 or one chord per beat), or too few changes. A new Chromium case runs a 48-bar song with 2+2 in every bar: it shows the bar grid, and every bar names both chords. |
| **A long Now name ran over Next** (C#m7b5/G#). | The Now name is fitted to the room Next leaves. It steps down 44 → 40 → 36 → 32 → 28px. If it still does not fit, the slash bass goes on a second line ("C#m7b5" / "/G#"). If that still does not fit, Next moves to its own row. A new gate asserts the Now box never intersects any Next box, and that Now stays at 28px or more. It runs on a song made of long names at both widths. |
| **Bar groups were empty for screen readers.** | The chord buttons are now **inside** their bar's `role=group`. The group's name lists its chords in order, in the visible spelling ("Bar 3 of 8, Bridge: G7, Bb"). The gate checks, for every chord on screen, that the chord is inside its own bar's group and that the label lists the group's chords. |
| Should-fix: "Loop back to in 1 beat" | The label now reads "Loops back in 1 beat", with the chord below it. |

Tests: 23 unit tests. The gate grew to 14 Chromium tests. All 32 mutants (the earlier 27 plus 5 for these blockers) were each seen to fail it. This revision has not been re-scored by the reviewers yet.

## Final re-review at `e441c6e` (review 5): 92 / 88 / 88, FAIL on one regression, now fixed
| Blocker | Fix |
|---|---|
| **N1:** after the half-bar change, a 3/4 song that changes chord every 2 bars was drawn as 4/4. It showed invented "C \| Am" bars, "bar 1/3" and 4 beat dots. | **Meter is now tested first.** The view checks whether on-beat chord-time falls on one phase of a 3-beat cycle (`MAX_TRIPLE_SHARE` 0.6). The beat count runs across sections, so the worker's 4-beat section lines do not scramble it. If chord changes fall into a 3-beat cycle, the song is 3/4, 6/8 counted in eighths, or ambiguous (a change every 12 beats fits both), and the view shows the plain list. Only after that does the 4/4 beats-1+3 against 2+4 test run. This also fixes the old should-fix "3/4 changing every 4 bars fits 4/4". |

**New tests:** unit tests for 3/4 every 2 bars, 3/4 every 4 bars, 6/8 every 1 and 2 bars, a 3/4 song cut into 4-beat worker sections, and 4/4 at 2+2 and at 1 per bar (both still get bars). Chromium cases at 390 and 360 for 3/4 every 2 bars, 3/4 every bar and 6/8 in eighths (all show the sequence, with no dots and no splits), and 4/4 with 2 changes per bar (grid, both chords named). Mutants seen to fail: meter check removed, beat count restarted per section, the old tie rule, and the tie choosing beat 3.

**Limit:** 6/8 tracked at the dotted-quarter beat (2 beats per bar) cannot be told apart from 4/4 with two chords per bar using chord timing alone.

## Orientation should-fixes after `6907e9e` (88 on orientation): a real 3/4 grid
- **3/4 is drawn as 3-beat bars** when the meter is confident. That means at least 60% of on-beat chord-time falls on one phase of the 3-beat cycle (the count carries across sections), beating the next phase by 1.5×, and the song is not also explained by a 4-beat cycle. It uses the same Now/Next card, with **3 beat dots**, "bar n/N", "in N beats", and split bars (2+1).
- **6/8 counted in eighths** is drawn as two bars of three. 6/8 tracked at the dotted-quarter beat still cannot be told apart from 4/4 with two chords per bar.
- **Uncertain meter gets the plain list.** That covers a 3-beat share between 0.45 and the 3/4 test, and a 12-beat cycle (3/4 changing every 4 bars, or 4/4 every 3 bars). This fixes **S1**: 3/4 alternating 2+1 and 1+2 is no longer drawn as 4/4 bars.
- **Tests:**
  - Unit tests: 3/4 every bar, every 2 bars, 2+1 and 6/8 get 3-beat bars on the true downbeats; the same holds inside 4-beat worker sections; the uncertain cases give the list; 4/4 at 2+2, 1 per bar, 3+1 and 3+3+2 keep 4-beat bars.
  - Chromium, at 390 and 360, 7 meter cases. For the bar cases the gate checks bar n/N, 3 or 4 dots, the lit beat, and that every bar on screen holds that bar's own chords.
  - Mutants seen to fail: no 3/4 grid, 4 dots on 3/4, a wrong 3/4 downbeat, the uncertain band removed, the 12-beat ambiguity ignored, and a 4-beat dot count on 3/4.

Not done (should-fix, not must-fix):
- tap-to-seek, with editing on a long press;
- folding "All chords" behind a disclosure on phones;
- ping-pong rows, so the current bar never moves on screen;
- per-bar section labels for sections that start mid-bar (the edges snap to the nearest bar line);
- at 360px a line can switch between 1×4 and 2×2 as it pages;
- 1.5% tempo drift falls back to the sequence;
- 4/4 that changes only every 3 bars is shown as the plain list (it is indistinguishable from 3/4 changing every 4 bars).

## Desktop
Desktop is unchanged. The phone view renders only under `NARROW_BREAKPOINT_PX` (560px). Review 3 diffed the desktop DOM against the base at 1280px and 820px, and it was identical.
