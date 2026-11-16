# Chords on phones: decision note (2026-11-15)

**Problem (Jon, on a phone):** "it's really hard to see them. You just see a whole large list of different chords. You don't know where you're at. They should be streaming by or expanded. It has to be more clear, especially chords when you have two chords in one bar."
**Stories:** 3 (see the chords go by, a marker on the current chord, auto-follow, legible from the playing position, current chord at least 20px) and 4.8 (big sections; keep the chord-root hues).

## Reference products (described, nothing copied)
- **Moises** (help centre: "How to use the new Chords view — Grid Mode" and "How do I use Chord Detection?"): mobile has a *bar mode* (a strip of chords in sync with playback) and a *grid mode* that "shows the song's full structure, with chords synced to bars and beats", with sections in the same view.
- **Chordify** (Music Mark resource page; app store screens): an *animated view* aligned with playback, plus a chord overview or grid as the alternative.
- What they have in common, and what we lacked: chords sit on **bars and beats**, not on seconds, and one chord is clearly *the* current one.

## Data the design relies on
Chords come from `play.chords.json` (seconds only). Bars come from the job's `loops` rows: each carries `bpm`, and each `start_sec` is snapped to a detected beat (`beat_grid.py`). The worker does not detect bar 1, so the downbeat is picked from the chords: the beat phase on which the most chord-time starts (`downbeatPhase`). On the fixture, the phase is 1 of 4, as planted. With no tempo (a beatless track), the view falls back to a pseudo-bar the length of a typical chord, and it hides bar numbers.

## Candidates (all built in one branch behind `?chordview=`; screenshots in this folder)
Fixture: a synthetic 4:00 song (`apps/web/test/fixtures/play-chords-4m-two-chord-bars.json`) at 96 bpm, with 30 two-chord bars (2+2 and 3+1) and ±35 ms boundary jitter. The playhead is at 2:17, inside the split bar Em7 | Am. Shots at 390×844 and 360×800, with and without `prefers-reduced-motion`.

| | Layout | Files |
|---|---|---|
| A | **Streaming lane.** Bars slide right to left past a fixed playhead (about 2 bars ahead are visible), split bars are halved, and a "Now" readout sits below. With reduced motion, the lane steps one bar at a time. | `A-lane-*.png` |
| B | **Bar grid.** 4 bars per row, 5 rows visible, the current bar ringed, auto-scrolled so the current row is the second one, and "Follow playback" after a manual scroll. | `B-grid-*.png` |
| C | **Now/Next focus and two lines.** A card shows the section and bar ("Chorus · bar 55"), the current chord at 44px, the beat of the bar, and the next chord with "in N beats". Below it are the line being played and the next line (4 bars each), with split bars in proportion to their beats. The lines page when playback crosses a line, so nothing moves continuously. | `C-focus-*.png` |

All three show lead-sheet symbols (Am7, G7/D). The Harte label stays on `aria-label`/`title` and in the full list.

## Reviews: NOT the three independent Opus reviews the brief asked for
The session that built this had no Agent tool, so it **could not spawn independent reviewers**. The scores below are the builder's own pass through the three lenses. They are recorded as a working judgement, **not** as the >90 review gate. The PR is a draft until three independent Opus reviews have run.

| Lens (self-scored /100) | A lane | B grid | C focus |
|---|---|---|---|
| Guitarist at arm's length: current chord size, split-bar names | 78: the current chord is 32px, but names slide while you read them | 70: at 360px, the split-bar names drop out (Em7 and Dm7 blank in `B-grid-360x800.png`) | 92: the current chord is 44px, the next 24px, every split name is shown at 360px |
| "Where am I": bar, section, what's next | 80: you can see what is coming, but no section and no count-in | 82: bar numbers and the whole structure, but no section or next-chord cue, and the view scrolls | 93: section, bar number, beat dots, "Next in 2 beats", the current bar ringed in the current line |
| Accessibility and motion (prefers-reduced-motion, targets, contrast) | 72: continuous motion is the default; the reduced mode jumps a whole bar | 85: smooth scroll (instant when reduced) | 91: no continuous motion at all; slots are 52px tall (≥44 px); text is never below the A15 11px floor |
| **Average** | **76.7** | **79.0** | **92.0** |

**Winner: C.** It answers Jon's three complaints directly. "You don't know where you're at" is answered by the section, the bar and the beat dots. "Two chords in one bar" is answered by one cell split by beats. "Streaming by" is answered by the next chord and its count, with the next line always on screen. It also needs no motion, which makes reduced motion a non-issue rather than a degraded mode.

Known weaknesses of C, for the independent reviewers:
1. The lines *page* every 4 bars. A reviewer may prefer a one-bar scroll.
2. At 360px, the non-current half of a split bar can drop to 11px.
3. The full "All chords" list (Harte spelling, zoomable, editable) stays below the view. It keeps #212's every-chord-reachable guarantee, but two spellings now appear on one screen.
4. The colours are the existing inline ones (the off-palette pink playhead); the token pass is separate.

## Desktop
Desktop is unchanged. The phone view renders only under `NARROW_BREAKPOINT_PX` (560px), where the old wrapped list was the problem. The desktop strip already has a playhead, auto-scroll and a 24px "Now" readout (#274), and C has not been reviewed at desktop widths.

## Tests
`packages/web-browser-gate/test/chord-phone-view.test.mjs` runs in real Chromium at 390 and 360. It checks that the current chord is ≥24px, weight ≥600, on screen and unclipped, and names the chord under the playhead. It checks that both chords of a split bar render their names, unclipped and ≥11px. It checks auto-follow across 9 bars and 3 line pages, and that one primary chip per segment remains in the full list. Four mutants were each seen to fail it: the current chord at 20px, paging disabled, slot names removed, and the whole bar marked current. The #212 chip-fit gate and the #274 size gate are unchanged and green.
