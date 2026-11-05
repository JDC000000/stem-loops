"""Eval tests — synthetic GT + prediction → expected mir_eval score, 3-shuffle
stats, per-song floor raises when violated.

CPU-only. No network. No dataset download. No GPU.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from training.eval import EvalGateFailure, run_eval, score_song
from training.eval import _gt_to_intervals as gt_to_intervals


def _write_eval_fixture(path: Path, song_ids: list[str]) -> None:
    payload = {
        "_schema": {"description": "test fixture"},
        "songs": [
            {
                "fma_id_or_jamendo_id": sid,
                "title": sid,
                "artist": "test",
                "license": "CC0",
                "url": "https://example.test",
                "duration_sec": 10.0,
            }
            for sid in song_ids
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))


# ---------------------------------------------------------------------------
# score_song: perfect prediction = 1.0 MajMin
# ---------------------------------------------------------------------------


def test_perfect_prediction_scores_1_0() -> None:
    gt = [(0.0, 2.0, "C:maj"), (2.0, 4.0, "G:maj"), (4.0, 6.0, "N")]
    gt_intervals, gt_labels = gt_to_intervals(gt)
    pred_intervals, pred_labels = gt_to_intervals(gt)  # identical
    scores = score_song(pred_intervals, pred_labels, gt_intervals, gt_labels)
    assert scores["majmin"] == pytest.approx(1.0, abs=1e-6)
    assert scores["root"] == pytest.approx(1.0, abs=1e-6)
    assert scores["triads"] == pytest.approx(1.0, abs=1e-6)


def test_wrong_root_zero_majmin() -> None:
    gt = [(0.0, 2.0, "C:maj")]
    pred = [(0.0, 2.0, "D:maj")]
    gt_intervals, gt_labels = gt_to_intervals(gt)
    pred_intervals, pred_labels = gt_to_intervals(pred)
    scores = score_song(pred_intervals, pred_labels, gt_intervals, gt_labels)
    assert scores["majmin"] == pytest.approx(0.0, abs=1e-6)
    assert scores["root"] == pytest.approx(0.0, abs=1e-6)


# ---------------------------------------------------------------------------
# 3-shuffle stats — mean + std populated for each metric
# ---------------------------------------------------------------------------


def test_three_shuffle_run_populates_mean_std(tmp_path: Path) -> None:
    eval_fixture = tmp_path / "songs.json"
    report_out = tmp_path / "reports"
    _write_eval_fixture(eval_fixture, song_ids=["song_a", "song_b", "song_c"])

    gt = {
        "song_a": [(0.0, 2.0, "C:maj"), (2.0, 4.0, "G:maj")],
        "song_b": [(0.0, 2.0, "A:min"), (2.0, 4.0, "F:maj")],
        "song_c": [(0.0, 2.0, "D:maj"), (2.0, 4.0, "N")],
    }
    # Predictions perfectly match -> MajMin should be 1.0 across all shuffles.
    preds = {k: v[:] for k, v in gt.items()}

    report = run_eval(
        checkpoint=tmp_path / "unused.pt",
        eval_songs=eval_fixture,
        audio_cache=tmp_path / "noaudio",
        shuffles=3,
        report_out=report_out,
        per_song_floor=0.5,
        compare_provider=None,
        seed=0,
        model_version="smoke",
        mock_predictions=preds,
        mock_gt=gt,
    )
    assert report["n_shuffles"] == 3
    agg = report["aggregate"]  # type: ignore[assignment]
    # Perfect predictions → mean 1.0, std 0.0 across (3 shuffles × 3 songs)
    assert agg["majmin"]["mean"] == pytest.approx(1.0, abs=1e-6)
    assert agg["majmin"]["std"] == pytest.approx(0.0, abs=1e-6)
    # Per-song array has 3 entries per metric.
    assert all(len(v["majmin"]) == 3 for v in report["per_song"].values())  # type: ignore[call-overload]
    # Report file written.
    assert (report_out / "eval_smoke.json").exists()


# ---------------------------------------------------------------------------
# Per-song floor raises when violated
# ---------------------------------------------------------------------------


def test_per_song_floor_raises_on_violation(tmp_path: Path) -> None:
    eval_fixture = tmp_path / "songs.json"
    _write_eval_fixture(eval_fixture, song_ids=["easy", "hard"])

    gt = {
        "easy": [(0.0, 4.0, "C:maj")],
        "hard": [(0.0, 4.0, "C:maj")],
    }
    preds = {
        "easy": [(0.0, 4.0, "C:maj")],  # perfect
        "hard": [(0.0, 4.0, "F#:maj")],  # 0% majmin (wrong root)
    }
    with pytest.raises(EvalGateFailure) as exc:
        run_eval(
            checkpoint=tmp_path / "unused.pt",
            eval_songs=eval_fixture,
            audio_cache=tmp_path / "noaudio",
            shuffles=2,
            report_out=tmp_path / "reports",
            per_song_floor=0.5,
            compare_provider=None,
            seed=0,
            model_version="smoke",
            mock_predictions=preds,
            mock_gt=gt,
        )
    assert "hard" in str(exc.value)


def test_per_song_floor_passes_at_exact_threshold(tmp_path: Path) -> None:
    """A song at exactly the floor must NOT raise (strict <, not <=)."""
    eval_fixture = tmp_path / "songs.json"
    _write_eval_fixture(eval_fixture, song_ids=["half"])

    gt = {
        "half": [
            (0.0, 2.0, "C:maj"),  # 50% of total duration
            (2.0, 4.0, "G:maj"),  # the other 50%
        ]
    }
    preds = {
        "half": [
            (0.0, 2.0, "C:maj"),  # correct
            (2.0, 4.0, "D:maj"),  # wrong — 0% majmin on the second half
        ]
    }
    report = run_eval(
        checkpoint=tmp_path / "unused.pt",
        eval_songs=eval_fixture,
        audio_cache=tmp_path / "noaudio",
        shuffles=1,
        report_out=tmp_path / "reports",
        per_song_floor=0.5,
        compare_provider=None,
        seed=0,
        model_version="smoke-threshold",
        mock_predictions=preds,
        mock_gt=gt,
    )
    # No violation listed (0.5 >= 0.5).
    assert report["per_song_floor_violated"] == []


# ---------------------------------------------------------------------------
# Baseline-compare optional path
# ---------------------------------------------------------------------------


def test_compare_provider_missing_baseline_is_warned_not_crashed(tmp_path: Path) -> None:
    eval_fixture = tmp_path / "songs.json"
    _write_eval_fixture(eval_fixture, song_ids=["s1"])
    gt = {"s1": [(0.0, 2.0, "C:maj")]}
    preds = {"s1": [(0.0, 2.0, "C:maj")]}

    report = run_eval(
        checkpoint=tmp_path / "unused.pt",
        eval_songs=eval_fixture,
        audio_cache=tmp_path / "noaudio",
        shuffles=1,
        report_out=tmp_path / "reports",
        per_song_floor=0.5,
        compare_provider="klangio",
        seed=0,
        model_version="smoke-compare",
        mock_predictions=preds,
        mock_gt=gt,
    )
    assert report["baseline_provider"] == "klangio"
    # No fixture on disk — report should flag the gap.
    assert "baseline_warning" in report


# ---------------------------------------------------------------------------
# Factored per-head metrics (PR-Y1.4b)
# ---------------------------------------------------------------------------


def test_score_song_reports_factored_head_metrics() -> None:
    """score_song's return dict includes quality_head + bass_head WCSR."""
    gt = [(0.0, 2.0, "C:maj/3"), (2.0, 4.0, "G:7")]
    pred = [(0.0, 2.0, "C:maj/3"), (2.0, 4.0, "G:7")]  # perfect
    gt_intervals, gt_labels = gt_to_intervals(gt)
    pred_intervals, pred_labels = gt_to_intervals(pred)
    scores = score_song(pred_intervals, pred_labels, gt_intervals, gt_labels)
    assert "quality_head" in scores
    assert "bass_head" in scores
    assert scores["quality_head"] == pytest.approx(1.0, abs=1e-6)
    # Bass head on chord frames: both frames match their bass slot.
    assert scores["bass_head"] == pytest.approx(1.0, abs=1e-6)


def test_quality_head_catches_seven_vs_maj_distinction() -> None:
    """A model that predicts ``maj`` where the GT is ``7`` scores 0 on quality_head.

    This is exactly the information the flat-60 alphabet threw away — the
    factored head preserves it, which is the empirical reason for the switch.
    """
    gt = [(0.0, 4.0, "C:7")]
    pred = [(0.0, 4.0, "C:maj")]  # flat-60 demotion
    gt_intervals, gt_labels = gt_to_intervals(gt)
    pred_intervals, pred_labels = gt_to_intervals(pred)
    scores = score_song(pred_intervals, pred_labels, gt_intervals, gt_labels)
    assert scores["quality_head"] == pytest.approx(0.0, abs=1e-6)


def test_bass_head_on_n_frames_is_undefined() -> None:
    """N frames don't contribute to the bass accuracy denominator."""
    gt = [(0.0, 2.0, "C:maj/3"), (2.0, 4.0, "N")]
    pred = [(0.0, 2.0, "C:maj/3"), (2.0, 4.0, "N")]  # perfect
    gt_intervals, gt_labels = gt_to_intervals(gt)
    pred_intervals, pred_labels = gt_to_intervals(pred)
    scores = score_song(pred_intervals, pred_labels, gt_intervals, gt_labels)
    # Bass only scored on the chord frame; that frame is correct → 1.0.
    assert scores["bass_head"] == pytest.approx(1.0, abs=1e-6)


def test_bass_head_catches_slash_chord_miss() -> None:
    """Predicting the root voicing where the GT has a /3 slash misses bass."""
    gt = [(0.0, 4.0, "C:maj/3")]
    pred = [(0.0, 4.0, "C:maj")]  # dropped the slash
    gt_intervals, gt_labels = gt_to_intervals(gt)
    pred_intervals, pred_labels = gt_to_intervals(pred)
    scores = score_song(pred_intervals, pred_labels, gt_intervals, gt_labels)
    assert scores["majmin"] == pytest.approx(1.0, abs=1e-6)  # majmin ignores bass
    assert scores["bass_head"] == pytest.approx(0.0, abs=1e-6)


def test_factored_eval_report_includes_bass_floor_fields(tmp_path: Path) -> None:
    """A run with per_song_bass_floor set records the field in the report."""
    eval_fixture = tmp_path / "songs.json"
    _write_eval_fixture(eval_fixture, song_ids=["s1"])
    gt = {"s1": [(0.0, 4.0, "C:maj/3")]}
    pred = {"s1": [(0.0, 4.0, "C:maj/3")]}  # perfect

    report = run_eval(
        checkpoint=tmp_path / "unused.pt",
        eval_songs=eval_fixture,
        audio_cache=tmp_path / "noaudio",
        shuffles=1,
        report_out=tmp_path / "reports",
        per_song_floor=0.5,
        per_song_bass_floor=0.5,
        compare_provider=None,
        seed=0,
        model_version="smoke-bass",
        mock_predictions=pred,
        mock_gt=gt,
    )
    assert report["per_song_bass_floor"] == 0.5
    assert report["per_song_bass_floor_violated"] == []
    agg = report["aggregate"]  # type: ignore[assignment]
    assert "bass_head" in agg
    assert "quality_head" in agg


def test_per_song_bass_floor_raises_on_violation(tmp_path: Path) -> None:
    """Below-floor bass accuracy blocks the ship."""
    eval_fixture = tmp_path / "songs.json"
    _write_eval_fixture(eval_fixture, song_ids=["bass-weak"])
    # Predict a chord with the root voicing but GT has a slash — bass head = 0.
    gt = {"bass-weak": [(0.0, 4.0, "C:maj/3")]}
    pred = {"bass-weak": [(0.0, 4.0, "C:maj")]}
    with pytest.raises(EvalGateFailure) as exc:
        run_eval(
            checkpoint=tmp_path / "unused.pt",
            eval_songs=eval_fixture,
            audio_cache=tmp_path / "noaudio",
            shuffles=1,
            report_out=tmp_path / "reports",
            per_song_floor=0.0,  # disable majmin floor for this test
            per_song_bass_floor=0.5,
            compare_provider=None,
            seed=0,
            model_version="smoke-bass-floor",
            mock_predictions=pred,
            mock_gt=gt,
        )
    assert "Bass floor" in str(exc.value)
    assert "bass-weak" in str(exc.value)


def test_per_song_bass_floor_disabled_at_zero(tmp_path: Path) -> None:
    """per_song_bass_floor=0 (default) doesn't raise even when bass is bad."""
    eval_fixture = tmp_path / "songs.json"
    _write_eval_fixture(eval_fixture, song_ids=["bass-weak"])
    gt = {"bass-weak": [(0.0, 4.0, "C:maj/3")]}
    pred = {"bass-weak": [(0.0, 4.0, "C:maj")]}  # bass = 0, majmin = 1.0
    report = run_eval(
        checkpoint=tmp_path / "unused.pt",
        eval_songs=eval_fixture,
        audio_cache=tmp_path / "noaudio",
        shuffles=1,
        report_out=tmp_path / "reports",
        per_song_floor=0.5,
        per_song_bass_floor=0.0,  # disabled
        compare_provider=None,
        seed=0,
        model_version="smoke-bass-disabled",
        mock_predictions=pred,
        mock_gt=gt,
    )
    assert report["per_song_bass_floor_violated"] == []
