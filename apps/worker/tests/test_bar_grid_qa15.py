"""QA-15: bar grid anchored at the music start, and following tempo drift.

Lesson recorded with the bug: test audio must include a lead-in and tempo drift. Every
track here is synthetic with exact ground truth (rendered in-test, nothing committed):

* lead-in: 1.5-3 s of silence or a non-beat tone before the first downbeat. The old grid
  counted bars from the first grid beat after t=0 (inside the silence), so bar 0 and the
  first loop sat before the music and the true downbeat fell on beat 2-4 of a grid bar.
* drift: 118 -> 124 BPM. The old grid extrapolated one fitted BPM, so bar starts slid up
  to ~1 s off the real bars (QA log: 436 ms on the reporting track).
* steady: the normal case must produce exactly the output it did before the fix.
"""

import os

import numpy as np
import pytest
import soundfile as sf

from worker.extractor.beat_grid import detect_music_start, estimate_beat_grid
from worker.extractor.loop_extractor import extract_loops

SR = 44100


def _render(beats: np.ndarray, dur: float, pad: tuple[float, float] | None = None, seed=0):
    """Kick on 1/3, snare on 2/4, hats on beats and 8ths, at the given beat times.

    ``pad``: (start, end) of a soft sustained 220 Hz tone — a non-beat lead-in.
    """
    rng = np.random.default_rng(seed)
    y = np.zeros(int(dur * SR))
    t = np.arange(int(0.2 * SR)) / SR
    kick = np.sin(2 * np.pi * np.cumsum(50 + 100 * np.exp(-t * 30)) / SR) * np.exp(-t * 12)
    snare = (0.6 * rng.standard_normal(len(t)) + 0.5 * np.sin(2 * np.pi * 190 * t)) * np.exp(
        -t * 25
    )
    hat = 0.3 * np.diff(rng.standard_normal(len(t)), prepend=0.0) * np.exp(-t * 80)

    def place(sample, at):
        s = int(round(at * SR))
        if 0 <= s < len(y):
            e = min(len(y), s + len(sample))
            y[s:e] += sample[: e - s]

    for i, b in enumerate(beats):
        place(kick if i % 2 == 0 else snare, b)
        place(hat, b)
        if i + 1 < len(beats):
            place(0.6 * hat, (b + beats[i + 1]) / 2)
    y = 0.8 * y / np.abs(y).max()
    if pad is not None:
        a, b = (int(x * SR) for x in pad)
        n = np.arange(b - a)
        env = np.minimum(1.0, n / (0.3 * SR)) * np.minimum(1.0, (b - a - n) / (0.05 * SR))
        y[a:b] += 0.05 * np.sin(2 * np.pi * 220 * n / SR) * env
    return y.astype(np.float32)


def _steady(bpm: float, first: float, dur: float) -> np.ndarray:
    return np.arange(first, dur - 0.3, 60.0 / bpm)


def _ramp(bpm0: float, bpm1: float, first: float, dur: float) -> np.ndarray:
    """Beat times with the tempo moving linearly in time from bpm0 to bpm1."""
    out, t = [first], first
    while True:
        t += 60.0 / (bpm0 + (bpm1 - bpm0) * (t - first) / (dur - first))
        if t > dur - 0.3:
            return np.array(out)
        out.append(t)


def _bar_errors(grid, beats: np.ndarray) -> np.ndarray:
    """grid bar n start minus the true start of bar n (true bar 0 = the first beat)."""
    downbeats = beats[::4]
    return np.array([grid.bar_start(n) - db for n, db in enumerate(downbeats)])


# ---------------------------------------------------------------------------
# Lead-in: bar 1 on the first musical downbeat, not in the silence before it.
# ---------------------------------------------------------------------------

LEAD_IN_CASES = [
    # bpm, first downbeat (s), non-beat pad before it
    (120.0, 1.75, None),  # old: bar 0 at 0.25 s; the real downbeat was beat 4 of a bar
    (102.0, 2.60, (0.8, 2.6)),  # soft tone lead-in, then drums
    (128.0, 3.00, None),
    (90.0, 1.50, (0.0, 1.5)),
]


@pytest.mark.parametrize("bpm,first,pad", LEAD_IN_CASES)
def test_lead_in_bar_one_is_the_first_downbeat(bpm, first, pad):
    beats = _steady(bpm, first, 60.0)
    grid = estimate_beat_grid(_render(beats, 60.0, pad), SR)
    beat = 60.0 / bpm
    # Spec: within ±1 beat. Held to 30 ms so an off-by-one-beat bar 1 cannot pass.
    assert abs(grid.anchor - first) < 0.030, f"bar 1 {grid.anchor:.3f}s vs {first}s"
    assert abs(grid.anchor - first) < beat
    assert not grid.follows_beats  # steady tempo keeps the constant grid
    assert np.max(np.abs(_bar_errors(grid, beats))) < 0.030


@pytest.mark.parametrize("bpm,first,pad", LEAD_IN_CASES[:2])
def test_lead_in_first_loop_starts_on_the_downbeat_not_before_the_music(tmp_path, bpm, first, pad):
    path = os.path.join(tmp_path, "drums.wav")
    sf.write(path, _render(_steady(bpm, first, 60.0), 60.0, pad), SR)
    loops = list(extract_loops({"drums": path}, 0.0, loop_length_bars=4))
    assert loops
    # Nothing starts in the lead-in (the walk begins at bar 1; it may prefer a phrase
    # boundary a bar or two in, as before the fix).
    assert loops[0]["start_sec"] > first - 0.030
    bar = 4 * 60.0 / bpm
    for loop in loops:  # every loop starts on a true downbeat, numbered from bar 1
        n = loop["start_bar"]
        assert abs(loop["start_sec"] - (first + n * bar)) < 0.030


def test_drumless_intro_is_kept_when_the_mix_starts_earlier():
    # Drums enter at 8.0 s (bar 5 at 120 BPM); the song (mix) starts at 0.0 s.
    beats = _steady(120.0, 8.0, 60.0)
    y = _render(beats, 60.0)
    alone = estimate_beat_grid(y, SR)
    assert abs(alone.anchor - 8.0) < 0.030
    grid = estimate_beat_grid(y, SR, music_start=0.0)
    assert abs(grid.anchor - 0.0) < 0.030  # extended back by whole bars (4)
    assert abs(grid.bar_start(4) - 8.0) < 0.030
    # A mix that starts with the drums changes nothing.
    assert estimate_beat_grid(y, SR, music_start=7.9) == alone


def test_detect_music_start():
    y = np.zeros(SR * 10, dtype=np.float32)
    y[int(2.5 * SR) :] = 0.3 * np.sin(2 * np.pi * 220 * np.arange(int(7.5 * SR)) / SR)
    assert detect_music_start(y, SR) == pytest.approx(2.5, abs=0.03)
    assert detect_music_start(np.zeros(SR, dtype=np.float32), SR) == 0.0


# ---------------------------------------------------------------------------
# Tempo drift: the grid follows the tracked beats.
# ---------------------------------------------------------------------------

DRIFT_CASES = [(118.0, 124.0, 1.0, 90.0), (124.0, 118.0, 2.2, 90.0), (118.0, 124.0, 0.15, 60.0)]


@pytest.mark.parametrize("bpm0,bpm1,first,dur", DRIFT_CASES)
def test_drift_bar_starts_follow_the_tempo(bpm0, bpm1, first, dur):
    beats = _ramp(bpm0, bpm1, first, dur)
    grid = estimate_beat_grid(_render(beats, dur), SR)
    assert grid.follows_beats
    err = np.abs(_bar_errors(grid, beats))
    beat = 60.0 / max(bpm0, bpm1)
    # Spec: < 1 beat everywhere (old fixed grid: up to ~1 s; QA log 436 ms). Measured ~2 ms.
    assert err.max() < beat
    assert err.max() < 0.030, f"max bar-start error {err.max() * 1000:.0f} ms"


def test_drift_loops_start_on_bars_and_span_their_bars(tmp_path):
    beats = _ramp(118.0, 124.0, 1.0, 90.0)
    path = os.path.join(tmp_path, "drums.wav")
    sf.write(path, _render(beats, 90.0), SR)
    downbeats = beats[::4]
    for bars in (1, 4):
        loops = list(extract_loops({"drums": path}, 0.0, loop_length_bars=bars))
        assert len(loops) >= 5
        for loop in loops:
            n = loop["start_bar"]
            assert abs(loop["start_sec"] - downbeats[n]) < 0.030
            if n + bars < len(downbeats):  # loop ends on the true bar n+bars: no slip
                assert abs(loop["end_sec"] - downbeats[n + bars]) < 0.030
            assert loop["audio"].shape[-1] == round((loop["end_sec"] - loop["start_sec"]) * SR)


def test_grid_bar_index_round_trips_on_a_drifting_grid():
    beats = _ramp(118.0, 124.0, 1.0, 90.0)
    grid = estimate_beat_grid(_render(beats, 90.0), SR)
    for n in (-2, 0, 1, 7, 20, 40, 60):
        assert grid.bar_index(grid.bar_start(n)) == n
        assert grid.snap_to_bar(grid.bar_start(n) + 0.3) == grid.bar_start(n)


# ---------------------------------------------------------------------------
# Steady tempo, no lead-in: output unchanged by the fix (captured on v3/main c9f69d0, 2026-11-23).
# ---------------------------------------------------------------------------

STEADY_BASELINE = {
    # (bpm, first, dur, bars): [(start_sec, start_bar), ...]
    (102.0, 0.12, 80.0, 4): [
        (0.118649, 0),
        (11.883538, 5),
        (23.648039, 10),
        (33.059879, 14),
        (44.824396, 19),
        (56.588947, 24),
        (66.002448, 28),
    ],
    (128.0, 0.05, 60.0, 4): [
        (0.050658, 0),
        (7.550594, 4),
        (16.92551, 9),
        (24.425442, 13),
        (33.800354, 18),
        (41.300282, 22),
        (50.675188, 27),
    ],
    (97.0, 0.4, 60.0, 4): [
        (0.399866, 0),
        (12.770989, 5),
        (25.142107, 10),
        (37.513219, 15),
        (49.884545, 20),
    ],
}


@pytest.mark.parametrize("key", list(STEADY_BASELINE))
def test_steady_tempo_output_is_unchanged(tmp_path, key):
    bpm, first, dur, bars = key
    path = os.path.join(tmp_path, "drums.wav")
    sf.write(path, _render(_steady(bpm, first, dur), dur), SR)
    y, _ = sf.read(path)
    grid = estimate_beat_grid(y.astype(np.float32), SR)
    assert grid.bpm == bpm and not grid.follows_beats
    loops = list(extract_loops({"drums": path}, grid.bpm, loop_length_bars=bars, grid=grid))
    got = [(round(lp["start_sec"], 6), lp["start_bar"]) for lp in loops]
    assert got == STEADY_BASELINE[key]
    true_len = bars * 4 * 60.0 / bpm
    for lp in loops:
        assert lp["end_sec"] - lp["start_sec"] == pytest.approx(true_len)
        assert lp["audio"].shape[-1] == round(true_len * SR)
