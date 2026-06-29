"""S5 unit tests: seam discontinuity below threshold; crossfade keeps a clean length.

Pass bar: all 4 tests green on the golden loop sample. Confirms zero-crossing
alignment lands near silence and the micro-crossfade introduces no clicks/NaNs.
"""

import os

import numpy as np
import pytest
import soundfile as sf

from seamless import align_and_crossfade, find_zero_crossing

HERE = os.path.dirname(__file__)
GOLDEN_LOOP = os.path.normpath(os.path.join(HERE, "..", "fixtures", "golden_loop.wav"))


@pytest.fixture
def golden():
    y, sr = sf.read(GOLDEN_LOOP, dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    return y, sr


def test_zero_crossing_alignment(golden):
    y, sr = golden
    mid = len(y) // 2
    zc = find_zero_crossing(y, mid)
    # Zero-crossing should be within +/-2048 samples of the requested point.
    assert abs(zc - mid) <= 2048
    # Value at the zero crossing is near zero.
    assert abs(float(y[zc])) < 0.1


def test_crossfade_no_clicks(golden):
    y, sr = golden
    loop = align_and_crossfade(y, sr, 0, len(y) - 1)
    # Seam discontinuity: first and last samples should be near zero.
    assert abs(float(loop[0])) < 0.05, f"Loop start not near zero: {loop[0]}"
    assert abs(float(loop[-1])) < 0.05, f"Loop end not near zero: {loop[-1]}"


def test_loop_length_within_bar_tolerance(golden):
    y, sr = golden
    # Assume 120 BPM → 1 bar = 4 beats * (60/120) = 2.0s.
    bar_samples = int(sr * 2.0)
    loop = align_and_crossfade(y, sr, 0, 4 * bar_samples)
    # Length should be within +/-1 bar of the requested 4-bar window.
    assert abs(len(loop) - 4 * bar_samples) <= bar_samples


def test_no_nan_or_inf(golden):
    y, sr = golden
    loop = align_and_crossfade(y, sr, 0, len(y) - 1)
    assert not np.isnan(loop).any()
    assert not np.isinf(loop).any()
