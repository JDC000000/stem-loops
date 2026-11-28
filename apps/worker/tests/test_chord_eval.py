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
from types import SimpleNamespace

import pytest

from tests.db_guard import skip_or_fail
from worker.chord_eval import EvalReport, _mir_eval_row, main, run_eval  # noqa: F401 — re-export

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


# ---------------------------------------------------------------------------
# #522: the harness must produce REAL metric values, not ``*_error_len`` keys.
#
# Before #522, ``_mir_eval_row`` passed ``[metric]`` as a 5th positional argument to
# ``mir_eval.chord.evaluate(ref_i, ref_l, est_i, est_l, **kwargs)``. That raised
# TypeError for every metric, the except branch recorded ``{metric}_error_len``, and
# every provider row looked "fine" with no scores. These tests score a tiny labelled
# fixture (a precomputed provider output vs ``fixtures/chord_eval_tiny_ref.lab``) and
# pin the exact values mir_eval 0.8.2 gives, so that failure can't come back quietly.
#
# Reference (8 s):  0-2 C:maj | 2-4 G:7   | 4-6 A:min | 6-8 F:sus4
# Estimate:         0-2.5 C:maj | 2.5-4 G:maj | 4-6 C:maj | 6-8 F:maj
#   root     = (2 + 1.5 + 2) / 8           = 0.6875   (2-2.5 C≠G, 4-6 C≠A)
#   majmin   = (2 + 1.5) / 6               = 0.583333 (F:sus4 is outside the majmin
#              vocabulary, so 6-8 is excluded; G:7 reduces to G:maj)
#   sevenths = 2 / 6                       = 0.333333 (G:7 vs G:maj now wrong)
# The three values differ, and swapping ref/est changes majmin (0.4375) and sevenths
# (0.25), so a wrong metric key or swapped arguments both fail these tests.
# ---------------------------------------------------------------------------

TINY_REF_LAB = Path(__file__).parent / "fixtures" / "chord_eval_tiny_ref.lab"
TINY_EST_SEGMENTS = [
    (0.0, 2.5, "C:maj"),
    (2.5, 4.0, "G:maj"),
    (4.0, 6.0, "C:maj"),
    (6.0, 8.0, "F:maj"),
]
TINY_EXPECTED = {"root": 0.6875, "majmin": 3.5 / 6.0, "sevenths": 2.0 / 6.0}

MIR_EVAL_MISSING = (
    "mir_eval is not installed, so chord_eval cannot score any provider. Install it: "
    "cd apps/worker && pip install -r requirements.txt -r requirements-dev.txt "
    "-c constraints-prod.txt"
)


def _require_mir_eval() -> None:
    try:
        import mir_eval.chord  # noqa: F401, PLC0415
    except ImportError:
        skip_or_fail(MIR_EVAL_MISSING)


def _tiny_est_lab() -> str:
    return "\n".join(f"{s:.6f}\t{e:.6f}\t{lab}" for s, e, lab in TINY_EST_SEGMENTS)


def test_mir_eval_row_scores_tiny_fixture_with_real_values(tmp_path: Path) -> None:
    _require_mir_eval()
    ref = tmp_path / "ref.lab"
    ref.write_text(TINY_REF_LAB.read_text())
    scores = _mir_eval_row(_tiny_est_lab(), ref)
    assert not any(k.endswith("_error_len") for k in scores), scores
    assert set(scores) == set(TINY_EXPECTED), scores
    for metric, expected in TINY_EXPECTED.items():
        assert scores[metric] == pytest.approx(expected, abs=1e-6), (metric, scores)
        assert isinstance(scores[metric], float)


def test_mir_eval_row_perfect_estimate_scores_one(tmp_path: Path) -> None:
    _require_mir_eval()
    ref = tmp_path / "ref.lab"
    ref.write_text(TINY_REF_LAB.read_text())
    scores = _mir_eval_row(TINY_REF_LAB.read_text(), ref)
    assert scores == {"root": 1.0, "majmin": 1.0, "sevenths": 1.0}


def test_mir_eval_row_leaves_no_file_beside_the_reference(tmp_path: Path) -> None:
    """The predicted .lab used to be written next to the ground truth (a repo fixture)."""
    _require_mir_eval()
    ref = tmp_path / "ref.lab"
    ref.write_text(TINY_REF_LAB.read_text())
    _mir_eval_row(_tiny_est_lab(), ref)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["ref.lab"]


def test_mir_eval_row_records_error_len_keys_when_evaluate_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If mir_eval raises, every metric gets a ``*_error_len`` key and no score key."""
    _require_mir_eval()
    import mir_eval.chord  # noqa: PLC0415

    message = "boom: bad labels"

    def _raise(*_args, **_kwargs):  # noqa: ANN002, ANN003, ANN202
        raise ValueError(message)

    monkeypatch.setattr(mir_eval.chord, "evaluate", _raise)
    ref = tmp_path / "ref.lab"
    ref.write_text(TINY_REF_LAB.read_text())
    scores = _mir_eval_row(_tiny_est_lab(), ref)
    assert scores == {
        "root_error_len": float(len(message)),
        "majmin_error_len": float(len(message)),
        "sevenths_error_len": float(len(message)),
    }


class _TinySource:
    def recognize(self, _path, *, stem="mix"):  # noqa: ANN001
        return SimpleNamespace(
            provider="stub",
            provider_version="0",
            key="C:maj",
            segments=[
                SimpleNamespace(start_sec=s, end_sec=e, label=lab)
                for s, e, lab in TINY_EST_SEGMENTS
            ],
        )


def test_run_eval_records_real_metrics_for_labelled_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end through run_eval: cached audio + ground_truth_lab -> real scores."""
    _require_mir_eval()
    monkeypatch.delenv("CHORD_EVAL_FETCH", raising=False)
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "tiny.audio").write_bytes(b"")  # cached, so nothing is fetched
    ref = tmp_path / "ref.lab"
    ref.write_text(TINY_REF_LAB.read_text())
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "songs": [
                    {
                        "fma_id_or_jamendo_id": "tiny",
                        "title": "tiny",
                        "url": "https://example.invalid/tiny.wav",
                        "duration_sec": 8,
                        "ground_truth_lab": str(ref),
                    }
                ]
            }
        )
    )
    report = run_eval(_TinySource(), manifest, cache)
    assert report.totals["songs_ok"] == 1
    scores = report.rows[0].mir_eval
    assert not any(k.endswith("_error_len") for k in scores), scores
    for metric, expected in TINY_EXPECTED.items():
        assert scores[metric] == pytest.approx(expected, abs=1e-6), (metric, scores)
