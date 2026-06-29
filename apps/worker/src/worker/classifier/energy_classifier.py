"""Per-segment energy classification (T16): low / mid / high by RMS tertiles."""

import numpy as np


def classify_energy(y: np.ndarray, sr: int, segments: list) -> list[str]:
    rms = [
        (
            float(np.sqrt(np.mean(y[int(s * sr) : int(e * sr)] ** 2)))
            if int(e * sr) > int(s * sr)
            else 0.0
        )
        for s, e in segments
    ]
    if not rms:
        return []
    a = np.array(rms)
    lo = float(np.percentile(a, 33))
    hi = float(np.percentile(a, 67))
    return ["low" if v <= lo else "high" if v >= hi else "mid" for v in rms]
