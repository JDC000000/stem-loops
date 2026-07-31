"""BPM and musical-key detection via librosa (T14).

Gate 0 S4 decision: librosa (zero added footprint). Key uses Krumhansl-Schmuckler
profile correlation over the mean chroma. The relative-major/minor weakness is a
known, accepted limitation.

CONFIDENCE FLOOR (hardening review C2). A correlation always has a maximum, so the
raw KS loop reports a specific key even for audio that has no key at all — an
isolated drum stem measured 0.26-0.33 here while the "winning" key jumped between
five different keys across seeds, and that value was rendered in the UI and baked
into every download filename. Anything below MIN_KEY_CORRELATION (or a NaN score,
e.g. digital silence) is therefore reported as None = "unknown key" instead of a
confidently-wrong note+mode. Empirical spread measured on this repo's own material:

    percussion-only            0.26 - 0.33   <- must be rejected
    single-pitch fixture beds  ~0.68
    real tonal content         ~0.85

Callers must also pick the right stem: BPM is reliable from drums, key never is.
See pipeline.extract_and_tag's TEMPO_STEM_PREFERENCE / KEY_STEM_PREFERENCE.
"""

import os

import librosa
import numpy as np

_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Minimum KS correlation required to report a key at all (see module docstring).
MIN_KEY_CORRELATION = float(os.environ.get("KEY_MIN_CORRELATION", "0.6"))


def detect_bpm(y: np.ndarray, sr: int) -> float:
    """Tempo of the beat-reference stem. Drums are the best input for this."""
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    return round(float(np.atleast_1d(tempo)[0]), 2)


def detect_key(y: np.ndarray, sr: int) -> str | None:
    """Best-correlating KS key, or None when the audio doesn't support one.

    None is a real, expected outcome (percussion, silence, atonal noise) — callers
    must handle an unknown key rather than substituting a default.
    """
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    # Digital silence / non-finite chroma makes every correlation NaN.
    if not np.all(np.isfinite(chroma)) or not np.any(chroma):
        return None
    best_score, best_key = -2.0, None
    for i in range(12):
        for profile, mode in ((_MAJOR, "major"), (_MINOR, "minor")):
            score = float(np.corrcoef(np.roll(profile, i), chroma)[0, 1])
            if np.isfinite(score) and score > best_score:
                best_score = score
                best_key = f"{_NOTES[i]} {mode}"
    if best_key is None or best_score < MIN_KEY_CORRELATION:
        return None
    return best_key


def detect_bpm_and_key(y: np.ndarray, sr: int, *, y_key: np.ndarray | None = None) -> dict:
    """Job-level tags. `y` is the TEMPO reference; `y_key` is the separate HARMONIC
    reference used for key detection.

    `y_key` is keyword-only and defaults to None (=> musical_key is None) on purpose:
    reusing a drums-shaped tempo reference for key detection is exactly the C2 bug,
    so a caller has to opt in explicitly with a stem it knows is harmonic.
    """
    return {
        "bpm": detect_bpm(y, sr),
        "musical_key": detect_key(y_key, sr) if y_key is not None else None,
    }
