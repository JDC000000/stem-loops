"""Loop extraction (T13): phrase-boundary → bar-align → slice per requested bars.

Builds on the S3 heuristic from scratch (V1 is reference-only). Guards against
beatless/too-short audio with EXTRACTION_FAILED so a bad source never yields junk.
"""

import librosa
import numpy as np

from ..errors import ExtractionFailedError
from .bar_aligner import snap_to_bars
from .phrase_boundary import detect_boundaries

VALID_BARS = {1, 2, 4, 8}
MIN_BARS = 8


def extract_loops(
    stem_paths: dict[str, str], bpm: float, sr: int = 44100, loop_length_bars: int = 4
):
    """Yield {stem, start_sec, end_sec, audio (channels,samples), sr} per loop."""
    if loop_length_bars not in VALID_BARS:
        raise ValueError(f"loop_length_bars must be in {VALID_BARS}")
    bar = 4 * 60.0 / bpm
    loop_dur = loop_length_bars * bar

    ref = next(iter(stem_paths))
    y_ref, _ = librosa.load(stem_paths[ref], sr=sr, mono=True)

    # Beat guard — reject beatless / wildly off-tempo audio.
    tempo, beats = librosa.beat.beat_track(y=y_ref, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])
    if len(beats) < 4 or tempo < 40 or tempo > 250:
        raise ExtractionFailedError(f"No reliable beat (tempo={tempo:.1f}, beats={len(beats)})")

    total_bars = len(y_ref) / sr / bar
    if total_bars < MIN_BARS:
        raise ExtractionFailedError(f"Too short: {total_bars:.1f} bars < {MIN_BARS}")

    boundaries = detect_boundaries(y_ref, sr)
    segments = snap_to_bars(boundaries, bpm, len(y_ref) / sr)

    for stem_name, stem_path in stem_paths.items():
        y, _ = librosa.load(stem_path, sr=sr, mono=False)
        if y.ndim == 1:
            y = y[np.newaxis, :]
        for seg_start, seg_end in segments:
            t = seg_start
            while t + loop_dur <= seg_end + 0.01:
                s = int(t * sr)
                e = int((t + loop_dur) * sr)
                chunk = y[:, s:e]
                if chunk.shape[1] >= int(loop_dur * sr * 0.9):
                    yield {
                        "stem": stem_name,
                        "start_sec": t,
                        "end_sec": t + loop_dur,
                        "audio": chunk,
                        "sr": sr,
                    }
                t += loop_dur
