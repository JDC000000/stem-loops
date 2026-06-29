"""Zero-crossing alignment + 7.5ms cosine-window micro-crossfade (T15).

Gate 0 S5 approved algorithm. Operates on (channels, samples); fades the loop
seam so the wrap from last sample to first is click-free.
"""

import numpy as np


def _nearest_zc(y: np.ndarray, target: int, radius: int = 2048) -> int:
    lo, hi = max(0, target - radius), min(len(y) - 1, target + radius)
    zcs = np.where(np.diff(np.sign(y[lo:hi])))[0]
    if not len(zcs):
        return target
    return int(zcs[np.argmin(np.abs(zcs - (target - lo)))] + lo)


def apply(audio: np.ndarray, sr: int, fade_ms: float = 7.5) -> np.ndarray:
    """Apply a cosine-window crossfade at the loop seam. audio shape: (channels, samples)."""
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]
    n = audio.shape[-1]
    fs = max(2, int(fade_ms / 1000 * sr))
    fs = min(fs, n // 2)
    result = audio.astype(np.float64).copy()
    cos_win = 0.5 * (1 - np.cos(np.pi * np.arange(fs) / fs))
    for ch in range(audio.shape[0]):
        y = audio[ch]
        zc_start = _nearest_zc(y, 0)
        zc_end = _nearest_zc(y, n - 1)
        end_idx = max(0, min(zc_end - fs, n - fs))
        result[ch, end_idx : end_idx + fs] *= 1 - cos_win
        result[ch, zc_start : zc_start + fs] *= cos_win
    return result
