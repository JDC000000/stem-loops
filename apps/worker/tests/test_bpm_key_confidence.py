"""Hardening C2: a key is only reported when the audio actually supports one.

Before this, detect_bpm_and_key always returned a specific note+mode — including
for a drums-only reference stem, where the "winning" key was effectively random
(it was still rendered in the UI and baked into every download filename). These
tests lock in the confidence floor and the drums-are-not-a-key-reference rule.
"""

import numpy as np
import pytest

from worker.tagger.bpm_key import MIN_KEY_CORRELATION, detect_bpm_and_key, detect_key

SR = 44100
DUR = 8.0


def _percussive(seed: int, dur: float = DUR) -> np.ndarray:
    """Drum-shaped stem: pitchless kick thumps + noise transients on a 120 BPM grid."""
    rng = np.random.default_rng(seed)
    y = np.zeros(int(SR * dur), dtype=np.float32)
    beat_hz = 2.0  # 120 BPM
    for n in range(int(dur * beat_hz)):
        kick_len = int(0.12 * SR)
        env = np.exp(-np.arange(kick_len) / (0.03 * SR))
        t = np.arange(kick_len) / SR
        kick = (np.sin(2 * np.pi * 60 * t) * env).astype(np.float32)
        noise = (rng.standard_normal(kick_len) * env * 0.3).astype(np.float32)
        s = int(n / beat_hz * SR)
        y[s : s + kick_len] += kick + noise
        hat_len = int(0.05 * SR)
        hat_env = np.exp(-np.arange(hat_len) / (0.008 * SR))
        h = int((n + 0.5) / beat_hz * SR)
        y[h : h + hat_len] += (rng.standard_normal(hat_len) * hat_env * 0.25).astype(np.float32)
    return (y / np.max(np.abs(y)) * 0.7).astype(np.float32)


def _tonal(semitones: int, dur: float = DUR) -> np.ndarray:
    """Harmonic stem: a sustained major triad with a 120 BPM amplitude pulse."""
    t = np.arange(int(SR * dur)) / SR
    y = np.zeros_like(t)
    for f in (261.63, 329.63, 392.00):
        y += 0.3 * np.sin(2 * np.pi * f * 2 ** (semitones / 12) * t)
    y *= 0.5 + 0.5 * np.sin(2 * np.pi * 2.0 * t)
    return (y / np.max(np.abs(y)) * 0.7).astype(np.float32)


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_percussive_stem_reports_no_key(seed):
    """The C2 repro input: drum-only audio must yield None, not a random key."""
    assert detect_key(_percussive(seed), SR) is None


def test_silence_reports_no_key():
    """Silence makes every correlation NaN — must be None, not the "C major" default."""
    assert detect_key(np.zeros(int(SR * DUR), dtype=np.float32), SR) is None


@pytest.mark.parametrize("semitones", [0, 3, 7])
def test_tonal_stem_still_reports_a_key(semitones):
    """The floor must not be so high that real harmonic content loses its key."""
    key = detect_key(_tonal(semitones), SR)
    assert key is not None and key.split()[1] in ("major", "minor")


def test_bpm_survives_a_percussive_reference():
    """Drums stay a perfectly good TEMPO reference — only the key is withheld."""
    tags = detect_bpm_and_key(_percussive(0), SR)
    assert tags["bpm"] == pytest.approx(120.0, abs=5.0)
    assert tags["musical_key"] is None


def test_key_reference_must_be_passed_explicitly():
    """y_key is keyword-only and defaults to None so a caller can't silently reuse
    the (possibly drums) tempo reference for key detection."""
    tonal = _tonal(0)
    assert detect_bpm_and_key(tonal, SR)["musical_key"] is None
    assert detect_bpm_and_key(_percussive(0), SR, y_key=tonal)["musical_key"] is not None


def test_floor_is_between_percussion_and_tonal_content():
    """Guards the empirical threshold itself: if a librosa upgrade shifts chroma
    scaling, this fails loudly instead of silently re-enabling fabricated keys."""
    assert 0.4 <= MIN_KEY_CORRELATION <= 0.8
