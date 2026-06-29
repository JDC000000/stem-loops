"""24-bit WAV encoding + waveform peaks for the UI (T18)."""

import numpy as np
import soundfile as sf

PEAKS = 800


def encode_24bit(audio: np.ndarray, sr: int, path: str) -> None:
    sf.write(path, audio.T if audio.ndim == 2 else audio, sr, subtype="PCM_24")


def waveform_peaks(audio: np.ndarray, n: int = PEAKS) -> list[float]:
    y = audio.mean(axis=0) if audio.ndim == 2 else audio
    cs = max(1, len(y) // n)
    return [float(np.sqrt(np.mean(y[i * cs : (i + 1) * cs] ** 2))) for i in range(n)]
