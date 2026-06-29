"""P2-15: the loop extractor yields >=5 distinct loops per stem on the golden fixture."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "fixtures"))
from make_stem_fixtures import ensure_fixtures  # noqa: E402

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
