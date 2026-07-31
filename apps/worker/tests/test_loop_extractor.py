"""P2-15: the loop extractor yields >=5 distinct loops per stem on the golden fixture."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "fixtures"))
from make_stem_fixtures import ensure_fixtures  # noqa: E402

from worker.errors import ExtractionFailedError  # noqa: E402
from worker.extractor.loop_extractor import extract_loops  # noqa: E402


def test_yields_at_least_5_loops_per_stem():
    paths = ensure_fixtures()
    loops = list(extract_loops(paths, bpm=120.0, loop_length_bars=4))
    by_stem: dict[str, int] = {}
    for loop in loops:
        by_stem[loop["stem"]] = by_stem.get(loop["stem"], 0) + 1
    assert by_stem, "no loops extracted"
    for stem, count in by_stem.items():
        assert count >= 5, f"{stem}: only {count} loops"


def test_zero_bpm_raises_extraction_failed_not_zero_division():
    """H9: a silent/beatless reference stem makes detect_bpm return 0.0, and
    `bar = 4*60/bpm` used to raise an unhandled ZeroDivisionError *before* the
    module's own beat guard could run — surfacing as a generic INTERNAL_ERROR
    instead of the intended EXTRACTION_FAILED."""
    paths = ensure_fixtures()
    for bad in (0.0, -12.0, float("nan"), float("inf")):
        with pytest.raises(ExtractionFailedError):
            list(extract_loops(paths, bpm=bad, loop_length_bars=4))


def test_zero_bpm_is_rejected_before_any_audio_is_loaded():
    """The guard is at the very top, so a bad tempo costs no decode work."""
    with pytest.raises(ExtractionFailedError):
        list(extract_loops({"drums": "/nonexistent/never-opened.wav"}, bpm=0.0))
