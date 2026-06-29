"""S3 spike: energy-envelope + harmonic-novelty phrase-boundary detector.

Heuristic-first (PRD §7 open question 3). Combines RMS energy novelty with
chromagram (harmonic) novelty, then peak-picks boundaries at least 4s apart.
Documented upgrade path to allin1 if the heuristic underperforms in production.
"""
import numpy as np
import librosa


def detect_boundaries(audio_path: str, hop_length: int = 512) -> list[float]:
    """Return a sorted list of detected phrase-boundary times (seconds)."""
    y, sr = librosa.load(audio_path, mono=True)

    # Energy-envelope novelty.
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_norm = rms / (rms.max() + 1e-6)

    # Chromagram novelty (harmonic changes).
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    chroma_diff = np.sum(np.abs(np.diff(chroma, axis=1)), axis=0)
    chroma_diff_norm = chroma_diff / (chroma_diff.max() + 1e-6)

    # Combine the two novelty curves (aligned lengths).
    min_len = min(len(rms_norm) - 1, len(chroma_diff_norm))
    novelty = 0.5 * rms_norm[1:min_len + 1] + 0.5 * chroma_diff_norm[:min_len]

    # Peak-pick boundaries, minimum 4 seconds apart.
    frames = librosa.util.peak_pick(
        novelty,
        pre_max=10, post_max=10, pre_avg=10, post_avg=10,
        delta=0.07, wait=int(4 * sr / hop_length),
    )
    times = librosa.frames_to_time(frames, sr=sr, hop_length=hop_length)
    return sorted(float(t) for t in times)


if __name__ == "__main__":
    import json
    import sys

    boundaries = detect_boundaries(sys.argv[1])
    print(json.dumps({"boundaries": boundaries, "count": len(boundaries)}))
