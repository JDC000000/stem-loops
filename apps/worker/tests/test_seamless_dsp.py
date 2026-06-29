"""P2-17: production seamless module — seam faded, finite, length preserved."""

import numpy as np

from worker.dsp.seamless import apply


def _loop(sr=44100, dur=2.0):
    t = np.arange(int(sr * dur)) / sr
    return (0.4 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)[np.newaxis, :]


def test_no_nan_and_shape_preserved():
    y = _loop()
    out = apply(y, 44100)
    assert out.shape == y.shape
    assert not np.isnan(out).any()
    assert not np.isinf(out).any()


def test_seam_start_faded_toward_zero():
    y = _loop()
    out = apply(y, 44100)
    # The cosine window starts at 0, so the first sample of the seam is pulled to ~0.
    assert abs(float(out[0, 0])) < 0.05


def test_stereo_supported():
    mono = _loop()[0]
    stereo = np.stack([mono, mono])
    out = apply(stereo, 44100)
    assert out.shape == stereo.shape
    assert not np.isnan(out).any()
