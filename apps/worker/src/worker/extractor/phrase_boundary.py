"""S3 heuristic phrase-boundary detector (T13).

Energy (RMS) + harmonic (chroma flux) novelty, thresholded at mean+std, with a
minimum 4s gap between boundaries. This is the heuristic-first path confirmed at
Gate 0 S3 (allin1 upgrade trigger: >=20% of jobs returning <5 loops/stem).
"""

import librosa
import numpy as np


def detect_boundaries(y: np.ndarray, sr: int, hop: int = 512) -> list[float]:
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    rms_n = rms / (rms.max() + 1e-8)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    chroma_flux = np.linalg.norm(np.diff(chroma, axis=1, prepend=chroma[:, :1]), axis=0)
    flux_n = chroma_flux / (chroma_flux.max() + 1e-8)
    novelty = 0.5 * rms_n + 0.5 * flux_n
    thr = novelty.mean() + novelty.std()
    peaks = np.where(novelty > thr)[0]
    min_gap = int(4.0 * sr / hop)
    times: list[float] = []
    last = -min_gap
    for f in peaks:
        if f - last >= min_gap:
            times.append(float(librosa.frames_to_time(f, sr=sr, hop_length=hop)))
            last = f
    return times
