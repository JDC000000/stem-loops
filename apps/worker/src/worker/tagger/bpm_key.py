"""BPM and musical-key detection via librosa (T14).

Gate 0 S4 decision: librosa (zero added footprint). Key uses Krumhansl-Schmuckler
profile correlation over the mean chroma. The relative-major/minor weakness is a
known, accepted limitation.
"""

import librosa
import numpy as np

_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def detect_bpm_and_key(y: np.ndarray, sr: int) -> dict:
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best_score, best_key = -2.0, "C major"
    for i in range(12):
        for profile, mode in ((_MAJOR, "major"), (_MINOR, "minor")):
            score = float(np.corrcoef(np.roll(profile, i), chroma)[0, 1])
            if score > best_score:
                best_score = score
                best_key = f"{_NOTES[i]} {mode}"
    return {"bpm": round(tempo, 2), "musical_key": best_key}
