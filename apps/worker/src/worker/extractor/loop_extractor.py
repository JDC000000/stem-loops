"""Loop extraction (T13): phrase-boundary → bar-align → slice per requested bars.

Builds on the S3 heuristic from scratch (V1 is reference-only). Guards against
beatless/too-short audio with EXTRACTION_FAILED so a bad source never yields junk.

Loops sit on a fitted beat grid (beat_grid.py): bars are counted from the first detected
beat (not t=0), and each loop start is snapped to the beat detected in its own window.
"""

import librosa
import numpy as np

from ..errors import ExtractionFailedError
from .beat_grid import BeatGrid, estimate_beat_grid
from .phrase_boundary import detect_boundaries

VALID_BARS = {1, 2, 4, 8}
MIN_BARS = 8
MAX_LOOPS_PER_STEM = 10  # cap per stem (>=5 distributed) to stay in the <60s p90 budget


def extract_loops(
    stem_paths: dict[str, str],
    bpm: float,
    sr: int = 44100,
    loop_length_bars: int = 4,
    grid: BeatGrid | None = None,
):
    """Yield {stem, start_sec, end_sec, start_bar, audio (channels,samples), sr} per loop.

    ``grid`` is the beat grid fitted on the reference stem (pipeline passes the one it
    used for tagging). Without it, one is fitted here at the given ``bpm``.
    """
    if loop_length_bars not in VALID_BARS:
        raise ValueError(f"loop_length_bars must be in {VALID_BARS}")

    ref = next(iter(stem_paths))
    y_ref, _ = librosa.load(stem_paths[ref], sr=sr, mono=True)
    if grid is None:
        grid = estimate_beat_grid(y_ref, sr, bpm=bpm)
    bar = grid.bar
    loop_dur = loop_length_bars * bar

    # Beat guard — reject beatless / wildly off-tempo audio.
    if grid.tracked_beats < 4 or grid.tracker_bpm < 40 or grid.tracker_bpm > 250:
        raise ExtractionFailedError(
            f"No reliable beat (tempo={grid.tracker_bpm:.1f}, beats={grid.tracked_beats})"
        )

    total_bars = len(y_ref) / sr / bar
    if total_bars < MIN_BARS:
        raise ExtractionFailedError(f"Too short: {total_bars:.1f} bars < {MIN_BARS}")

    song_len = len(y_ref) / sr
    boundaries = detect_boundaries(y_ref, sr)
    # Phrase boundaries snapped to the beat-anchored bar grid are the preferred (musical)
    # loop start anchors.
    bnd = sorted({grid.snap_to_bar(b) for b in boundaries if grid.snap_to_bar(b) >= 0})

    # Walk the whole song placing non-overlapping loop_dur loops. At each step,
    # prefer a phrase boundary that falls inside the upcoming window as the start
    # (so loops align to musical transitions); otherwise fall back to the bar grid.
    # This guarantees coverage across the song's structure and ~floor(len/loop_dur)
    # loops per stem (>=5 on any normal-length track) rather than only the loops
    # that happen to fit inside one short phrase segment.
    starts: list[float] = []
    t = grid.anchor  # first beat; the grid before it is silence/pickup
    while t + loop_dur <= song_len + 0.01:
        window = [b for b in bnd if t <= b < t + loop_dur and b + loop_dur <= song_len + 0.01]
        s = window[0] if window else t
        starts.append(s)
        t = s + loop_dur

    if not starts:
        raise ExtractionFailedError(
            f"No loops fit: {song_len:.1f}s < one {loop_length_bars}-bar loop"
        )

    # Cap to a sensible, evenly-distributed set (PRD: 5+ per stem distributed across
    # the structure — not every 4-bar window). Keeps the job inside the <60s budget.
    if len(starts) > MAX_LOOPS_PER_STEM:
        idx = {
            round(i * (len(starts) - 1) / (MAX_LOOPS_PER_STEM - 1))
            for i in range(MAX_LOOPS_PER_STEM)
        }
        starts = [starts[i] for i in sorted(idx)]

    # Snap each (grid) start to the beat detected inside its own window, so a slightly
    # drifting performance still gets on-beat starts. Bounded to ±0.1 beat by the grid.
    placed = []
    for nominal in starts:
        s = grid.local_beat(nominal, loop_dur)
        if s + loop_dur > song_len + 0.01:
            s = nominal
        placed.append((max(0.0, s), grid.bar_index(nominal)))

    for stem_name, stem_path in stem_paths.items():
        y, _ = librosa.load(stem_path, sr=sr, mono=False)
        if y.ndim == 1:
            y = y[np.newaxis, :]
        for start, start_bar in placed:
            s = int(round(start * sr))
            chunk = y[:, s : s + int(round(loop_dur * sr))]
            if chunk.shape[1] >= int(loop_dur * sr * 0.9):
                yield {
                    "stem": stem_name,
                    "start_sec": start,
                    "end_sec": start + loop_dur,
                    "start_bar": start_bar,
                    "audio": chunk,
                    "sr": sr,
                }
