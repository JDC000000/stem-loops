"""Generate deterministic synthetic stem WAVs with a clean, extractable 120 BPM beat.

Each stem = a loud steady tonal BED (keeps the phrase-boundary novelty flat, so the
S3 heuristic finds one long section instead of over-segmenting) + quiet broadband
TICKS every beat (enough onset for librosa.beat_track to lock 120 BPM and pass the
extractor's beat guard). Tuned so the reference stem yields ~8 four-bar loops.

Regenerable + gitignored — a runnable stand-in, not real audio.
"""

import os

import numpy as np
import soundfile as sf

SR = 44100
BPM = 120.0
DUR_S = 64.0
HERE = os.path.dirname(__file__)
# (stem, bed frequency Hz). drums is first → used as the extraction reference.
STEMS = (("drums", 110.0), ("bass", 82.0), ("vocals", 330.0))


def _beat_bed(freq: float, bed_amp: float = 0.5, tick_amp: float = 0.04) -> np.ndarray:
    n = int(SR * DUR_S)
    t = np.arange(n) / SR
    y = (bed_amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    rng = np.random.default_rng(7)
    burst = int(0.01 * SR)
    env = np.exp(-np.linspace(0, 12, burst)).astype(np.float32)
    tick = rng.standard_normal(burst).astype(np.float32) * env
    beat = 60.0 / BPM
    tt = 0.0
    while tt < DUR_S:
        s = int(tt * SR)
        e = min(s + burst, n)
        y[s:e] += tick[: e - s] * tick_amp
        tt += beat
    return y


def ensure_fixtures() -> dict[str, str]:
    """Generate the stem fixtures if missing; return {stem: path} (drums first)."""
    paths = {stem: os.path.join(HERE, f"golden_{stem}.wav") for stem, _ in STEMS}
    if all(os.path.exists(p) for p in paths.values()):
        return paths
    for stem, freq in STEMS:
        sf.write(paths[stem], _beat_bed(freq), SR)
    return paths


if __name__ == "__main__":
    for stem, path in ensure_fixtures().items():
        print(f"{stem:7s} -> {path}")
