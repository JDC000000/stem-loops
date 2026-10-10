"""Beat grid: precise tempo fit, first-beat anchor, on-beat loop starts, zero repeat slip.

Synthetic drum tracks with exact ground truth (rendered in-test, nothing committed).
The full before/after evaluation on real music lives in evals/beat_alignment/.
"""

import os

import numpy as np
import pytest
import soundfile as sf

from worker.errors import ExtractionFailedError
from worker.extractor.beat_grid import estimate_beat_grid, fit_tempo
from worker.extractor.loop_extractor import extract_loops
from worker.tagger.bpm_key import detect_bpm_and_key

SR = 44100


def _drums(bpm: float, first: float, dur: float, seed: int = 0) -> np.ndarray:
    """Kick on 1/3, snare on 2/4, 8th-note hats, starting at ``first`` seconds."""
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

    beat = 60.0 / bpm
    for i, b in enumerate(np.arange(first, dur - 0.3, beat)):
        place(kick if i % 2 == 0 else snare, b)
        place(hat, b)
        place(0.6 * hat, b + beat / 2)
    return (0.8 * y / np.abs(y).max()).astype(np.float32)


def _nearest_beat_offset(t: float, bpm: float, first: float) -> float:
    beat = 60.0 / bpm
    k = round((t - first) / beat)
    return t - (first + k * beat)


@pytest.mark.parametrize("bpm,first", [(102.0, 0.120), (101.7, 0.237), (128.0, 0.05)])
def test_tempo_fit_and_anchor_match_ground_truth(bpm, first):
    grid = estimate_beat_grid(_drums(bpm, first, 60.0), SR)
    assert grid.bpm == pytest.approx(bpm, abs=0.02)
    assert abs(_nearest_beat_offset(grid.anchor, bpm, first)) < 0.015


def test_integer_tempo_is_reported_exactly():
    # The old lag-binned tracker said 101.33 for a 102 BPM production.
    assert estimate_beat_grid(_drums(102.0, 0.12, 60.0), SR).bpm == 102.0


def test_given_bpm_is_kept_and_only_phase_is_fitted():
    grid = estimate_beat_grid(_drums(120.0, 0.3, 40.0), SR, bpm=120.0)
    assert grid.bpm == 120.0
    assert abs(_nearest_beat_offset(grid.anchor, 120.0, 0.3)) < 0.015


@pytest.mark.parametrize("bpm,first", [(102.0, 0.12), (70.0, 0.4)])
def test_tracker_matches_old_beat_track_exactly(bpm, first):
    # The metrical level (half/double-time) must not change: the coarse tempo is the
    # exact value the old `beat_track(y=...)` path reported.
    import librosa

    y = _drums(bpm, first, 40.0)
    old_tempo, old_beats = librosa.beat.beat_track(y=y, sr=SR)
    grid = estimate_beat_grid(y, SR)
    assert grid.tracker_bpm == float(np.atleast_1d(old_tempo)[0])
    assert grid.tracked_beats == len(old_beats)


def test_deterministic():
    y = _drums(97.0, 0.4, 40.0)
    a, b = estimate_beat_grid(y, SR), estimate_beat_grid(y, SR)
    assert a == b  # envelope excluded from comparison; bpm/anchor/tracker fields compared


def test_first_beat_at_zero_does_not_wrap_a_beat_later():
    grid = estimate_beat_grid(_drums(120.0, 0.0, 40.0), SR)
    assert abs(grid.anchor) < 0.015


def test_fit_tempo_resolves_between_lag_bins():
    # Impulse train at 101.7 BPM sampled at hop-512 frames; the coarse guess is a lag bin.
    frame_s = 512 / SR
    env = np.zeros(int(120 / frame_s))
    for b in np.arange(0.2, 119.0, 60 / 101.7):
        env[int(round(b / frame_s))] = 1.0
    assert fit_tempo(env, frame_s, 101.33) == pytest.approx(101.7, abs=0.02)


def test_local_beat_snaps_small_offsets_only():
    grid = estimate_beat_grid(_drums(100.0, 0.2, 60.0), SR)
    beat = 60.0 / 100.0
    on = 0.2 + 20 * beat
    assert abs(grid.local_beat(on + 0.04, 8 * beat) - on) < 0.015
    # Further than LOCAL_SNAP_MAX_BEATS (0.1 beat): not a snap any more — left alone.
    far = on + 0.4 * beat
    assert grid.local_beat(far, 8 * beat) == far


@pytest.fixture
def drum_track(tmp_path):
    path = os.path.join(tmp_path, "drums.wav")
    sf.write(path, _drums(102.0, 0.12, 80.0), SR)
    return path


@pytest.mark.parametrize("bars", [1, 2, 4])
def test_loops_start_on_beats_with_no_repeat_slip(drum_track, bars):
    y, _ = sf.read(drum_track)
    grid = estimate_beat_grid(y.astype(np.float32), SR)
    tags = detect_bpm_and_key(y.astype(np.float32), SR, grid=grid)
    assert tags["bpm"] == 102.0
    loops = list(
        extract_loops({"drums": drum_track}, tags["bpm"], loop_length_bars=bars, grid=grid)
    )
    assert len(loops) >= 5
    true_len = bars * 4 * 60.0 / 102.0
    for loop in loops:
        assert abs(_nearest_beat_offset(loop["start_sec"], 102.0, 0.12)) < 0.015
        assert loop["audio"].shape[-1] == round(true_len * SR)  # length = true bars → no slip
        assert loop["end_sec"] - loop["start_sec"] == pytest.approx(true_len)
    bars_idx = [loop["start_bar"] for loop in loops]
    assert bars_idx == sorted(bars_idx) and bars_idx[0] >= 0


def test_beatless_audio_still_fails_extraction(tmp_path):
    path = os.path.join(tmp_path, "silence.wav")
    sf.write(path, np.zeros(SR * 40, dtype=np.float32), SR)
    with pytest.raises(ExtractionFailedError):
        list(extract_loops({"drums": path}, 120.0))


def test_beatless_audio_fails_cleanly_on_the_pipeline_path(tmp_path):
    # Pipeline path: the grid is fitted first (bpm comes out 0 on silence) and passed in.
    # Must raise the typed EXTRACTION_FAILED, not divide by zero.
    path = os.path.join(tmp_path, "silence.wav")
    y = np.zeros(SR * 40, dtype=np.float32)
    sf.write(path, y, SR)
    grid = estimate_beat_grid(y, SR)
    tags = detect_bpm_and_key(y, SR, grid=grid)
    with pytest.raises(ExtractionFailedError):
        list(extract_loops({"drums": path}, tags["bpm"], grid=grid))
