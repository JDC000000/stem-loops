"""PR-Y1.1: chord-recognition eval harness — pytest-discoverable shim.

The real harness lives at ``apps/worker/src/worker/chord_eval.py`` so it can be
invoked as ``python -m worker.chord_eval --provider klangio`` per the Y1 plan.
This file is a thin re-export so the harness can also be referenced as a test
file in the standard tests/ directory — pytest collects it, sees no ``test_*``
functions (apart from the single collection-guard test below), and does NOT run
the live harness.

The guard-test IS a pytest test: it calls ``run_eval`` with a stub provider and
a temp manifest to prove the plumbing is wired. No network, no provider, no
downloads — verifies only that:
  * the manifest JSON loads,
  * the harness skips rows cleanly when CHORD_EVAL_FETCH is unset, and
  * the report shape is as advertised.

Live runs (actual Klangio calls, actual audio fetches) are strictly out-of-band:
``python -m worker.chord_eval --provider klangio``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from worker.chord_eval import EvalReport, main, run_eval  # noqa: F401 — re-export

# Keep main importable for ad-hoc invocation; silence lint.
__all__ = ["main", "run_eval", "EvalReport"]


class _StubSource:
    """Never actually called in this test — CHORD_EVAL_FETCH is unset so every row
    is skipped before recognize() runs. Present so run_eval has something to type
    against."""

    def recognize(self, _path, *, stem="mix"):  # noqa: ANN001, D401
        raise AssertionError("recognize() must not run when CHORD_EVAL_FETCH is unset")


def test_eval_harness_skips_cleanly_without_fetch_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Default run (no CHORD_EVAL_FETCH) → all rows skipped, no network calls."""
    monkeypatch.delenv("CHORD_EVAL_FETCH", raising=False)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "songs": [
                    {
                        "fma_id_or_jamendo_id": "t1",
                        "title": "t",
                        "artist": "a",
                        "license": "CC BY 4.0",
                        "url": "https://example.invalid/t.wav",
                        "duration_sec": 10,
                        "genre": "pop",
                        "expected_tempo_bpm": 120,
                        "notes": "test",
                    }
                ]
            }
        )
    )
    cache = tmp_path / "cache"
    report = run_eval(_StubSource(), manifest, cache)
    assert report.totals["songs_total"] == 1
    assert report.totals["songs_ok"] == 0
    assert report.totals["songs_skipped"] == 1
    assert report.rows[0].error and "skipped_no_fetch" in report.rows[0].error
    # And nothing landed in the cache — defensive against an accidental download.
    assert not cache.exists() or not any(cache.iterdir())
