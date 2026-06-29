"""S5: zero-crossing alignment + 5-10ms cosine-window micro-crossfade.

Produces seamless loops (PRD §4.3). Snap loop start/end to the nearest zero
crossing, then apply a short cosine crossfade at the seam so the wrap from the
last sample back to the first is click-free.
"""

import numpy as np


def find_zero_crossing(samples: np.ndarray, start: int, search_window: int = 2048) -> int:
    """Find the nearest zero-crossing to `start` within +/- search_window samples."""
    left = max(0, start - search_window)
    right = min(len(samples) - 1, start + search_window)
    window = samples[left:right]
    zc = np.where(np.diff(np.sign(window)))[0]
    if len(zc) == 0:
        return start
    nearest = zc[np.argmin(np.abs(zc - (start - left)))]
    return left + int(nearest)


def cosine_crossfade(loop: np.ndarray, sr: int, fade_ms: float = 7.5) -> np.ndarray:
    """Apply a cosine-window micro-crossfade at the loop seam to prevent clicks."""
    fade_samples = int(sr * fade_ms / 1000)
    fade_samples = max(1, min(fade_samples, len(loop) // 4))
    window = 0.5 * (1 - np.cos(np.pi * np.arange(fade_samples) / fade_samples))
    result = loop.astype(np.float64).copy()
    # Blend the head into the tail so the wrap point is continuous.
    result[-fade_samples:] *= 1 - window
    result[-fade_samples:] += loop[:fade_samples] * window
    return result[: len(loop) - fade_samples]  # trim so the loop keeps a clean length


def align_and_crossfade(
    audio: np.ndarray, sr: int, start_sample: int, end_sample: int, fade_ms: float = 7.5
) -> np.ndarray:
    """Extract a zero-crossing-aligned loop with a micro-crossfade at the seam."""
    aligned_start = find_zero_crossing(audio, start_sample)
    aligned_end = find_zero_crossing(audio, end_sample)
    loop = audio[aligned_start:aligned_end]
    return cosine_crossfade(loop, sr, fade_ms)
