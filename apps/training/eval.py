"""ChordNet 2E1D offline evaluation (PR-Y1.4).

Runs a trained ChordNet-2E1D checkpoint against the 20-song held-out eval set
(``apps/worker/tests/fixtures/chord_eval_songs.json``, from PR #73 / PR-Y1.1)
and reports ``mir_eval`` chord metrics:

- ``root``       — root-accuracy (``mir_eval.chord.root``).
- ``majmin``     — major/minor accuracy (``mir_eval.chord.majmin``).
- ``triads``     — triad accuracy (``mir_eval.chord.triads``).
- ``sevenths``   — seventh accuracy (``mir_eval.chord.sevenths``).
- ``mirex``      — MIREX blended metric (``mir_eval.chord.mirex``).

Decision-record v1.2 eval gate
------------------------------

The Y1 ship gate is **three independent shuffle runs** of the eval, with
mean + stddev reported per metric, plus a hard **per-song floor of 50%
MajMin WCSR**. Any single song falling below the floor raises
``EvalGateFailure`` and the ship is blocked.

CLI
---

.. code-block:: bash

    python -m training.eval \\
        --checkpoint apps/training/runs/exp1/best.pt \\
        --eval-songs apps/worker/tests/fixtures/chord_eval_songs.json \\
        --audio-cache apps/worker/.chord-eval-cache \\
        --shuffles 3 \\
        --report-out apps/training/eval_reports

Report schema
~~~~~~~~~~~~~

.. code-block:: json

    {
      "model_version": "v3-y1-exp1",
      "alphabet_sha": "...",
      "cqt_plan_version": "v1",
      "dataset_sha": "...",
      "n_shuffles": 3,
      "per_song": {
        "<song_id>": {
          "majmin": [0.82, 0.83, 0.81],
          "sevenths": [...],
          "triads": [...],
          "root": [...],
          "mirex": [...]
        }, ...
      },
      "aggregate": {
        "majmin":   {"mean": 0.82, "std": 0.009},
        "sevenths": {"mean": ...,  "std": ...},
        "triads":   {"mean": ...,  "std": ...},
        "root":     {"mean": ...,  "std": ...},
        "mirex":    {"mean": ...,  "std": ...}
      },
      "per_song_floor_majmin": 0.50,
      "per_song_floor_violated": []
    }
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import statistics
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import mir_eval
import numpy as np
import torch

from .model.alphabet import (
    ALPHABET_SHA,
    BASS_N_INDEX,
    BASS_SAME_INDEX,
    QUALITY_N_INDEX,
    encode_factored,
)
from .model.chordnet_2e1d import CQT_PLAN_VERSION, ChordNet2E1D

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class EvalGateFailure(RuntimeError):
    """Raised when the per-song floor is violated (ship-blocking)."""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m training.eval",
        description="ChordNet offline evaluation against the Y1 held-out set.",
    )
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument(
        "--eval-songs",
        type=Path,
        default=Path("apps/worker/tests/fixtures/chord_eval_songs.json"),
    )
    parser.add_argument(
        "--audio-cache",
        type=Path,
        default=Path("apps/worker/.chord-eval-cache"),
    )
    parser.add_argument("--shuffles", type=int, default=3)
    parser.add_argument(
        "--report-out",
        type=Path,
        default=Path("apps/training/eval_reports"),
    )
    parser.add_argument(
        "--per-song-floor",
        type=float,
        default=0.50,
        help="Minimum MajMin WCSR per song — below this is a hard gate violation.",
    )
    parser.add_argument(
        "--per-song-bass-floor",
        type=float,
        default=0.50,
        help=(
            "Minimum bass-head accuracy per song (factored v1.5 gate). "
            "Below this is a hard gate violation; set 0.0 to disable."
        ),
    )
    parser.add_argument(
        "--compare-provider",
        type=str,
        default=None,
        choices=[None, "klangio"],
        help="Also load this provider's baseline predictions for delta reporting.",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--model-version",
        type=str,
        default="v3-y1",
        help="String stamped into the report (``exp1``, ``exp2-pitched``, ...).",
    )
    return parser


# ---------------------------------------------------------------------------
# Eval-songs manifest
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EvalSong:
    """One row from ``chord_eval_songs.json``."""

    song_id: str
    title: str
    artist: str
    duration_sec: float
    url: str


def _read_eval_songs(manifest_path: Path) -> tuple[list[EvalSong], str]:
    """Return ``(songs, dataset_sha)``."""
    raw_bytes = manifest_path.read_bytes()
    dataset_sha = hashlib.sha256(raw_bytes).hexdigest()
    payload = json.loads(raw_bytes.decode("utf-8"))
    rows = payload.get("songs", [])
    songs = [
        EvalSong(
            song_id=r["fma_id_or_jamendo_id"],
            title=r.get("title", r["fma_id_or_jamendo_id"]),
            artist=r.get("artist", "?"),
            duration_sec=float(r.get("duration_sec", 0.0)),
            url=r.get("url", ""),
        )
        for r in rows
    ]
    return songs, dataset_sha


# ---------------------------------------------------------------------------
# Segment inference (callable — tests can swap in a stub)
# ---------------------------------------------------------------------------

# Type for "load one song's audio + ground-truth chord timeline."
AudioAndGtLoader = Callable[[EvalSong, Path], tuple[np.ndarray, list[tuple[float, float, str]]]]


def _default_loader(song: EvalSong, audio_cache: Path) -> tuple[
    np.ndarray,
    list[tuple[float, float, str]],
]:
    """Default loader: reads a cached (audio.npy, gt.jsonl) pair.

    The real-audio path is wired up by PR-Y1.3 (librosa CQT) + PR-Y1.1
    (fetched Jamendo/FMA audio under ``audio_cache``). For PR-Y1.4 we only
    need the contract: given (song, cache), return (audio-waveform, gt).
    """
    audio_path = audio_cache / f"{song.song_id}.npy"
    gt_path = audio_cache / f"{song.song_id}.gt.jsonl"
    if not audio_path.exists() or not gt_path.exists():
        raise FileNotFoundError(
            f"Cached audio/gt missing for {song.song_id}. Set CHORD_EVAL_FETCH=1 and run "
            "apps/worker/tests/test_chord_eval.py to populate."
        )
    audio = np.load(audio_path)
    gt: list[tuple[float, float, str]] = []
    with gt_path.open() as fh:
        for line in fh:
            row = json.loads(line.strip())
            gt.append((float(row["start"]), float(row["end"]), str(row["label"])))
    return audio, gt


def _segments_to_intervals(
    segments: list[tuple[int, int, str, float]],
    hop_length: int,
    sample_rate: int,
) -> tuple[np.ndarray, list[str]]:
    """Convert (start_frame, end_frame, label, conf) to (intervals, labels).

    ``mir_eval`` expects ``intervals`` as an ``(N, 2)`` array of start/end
    times in seconds and ``labels`` as a list of Harte strings.
    """
    frame_sec = hop_length / float(sample_rate)
    if not segments:
        return np.zeros((0, 2), dtype=np.float64), []
    intervals = np.array(
        [(s * frame_sec, e * frame_sec) for s, e, _lbl, _c in segments],
        dtype=np.float64,
    )
    labels = [lbl for _s, _e, lbl, _c in segments]
    return intervals, labels


def _gt_to_intervals(
    gt: list[tuple[float, float, str]],
) -> tuple[np.ndarray, list[str]]:
    if not gt:
        return np.zeros((0, 2), dtype=np.float64), []
    intervals = np.array([(s, e) for s, e, _lbl in gt], dtype=np.float64)
    labels = [lbl for _s, _e, lbl in gt]
    return intervals, labels


# ---------------------------------------------------------------------------
# mir_eval scoring
# ---------------------------------------------------------------------------


_METRIC_FUNCTIONS: dict[str, Callable[[np.ndarray, list[str]], np.ndarray]] = {
    "root": mir_eval.chord.root,
    "majmin": mir_eval.chord.majmin,
    "triads": mir_eval.chord.triads,
    "sevenths": mir_eval.chord.sevenths,
    "mirex": mir_eval.chord.mirex,
}

# Additional per-head metrics introduced in PR-Y1.4b for factored decoding.
# Computed from the decoded Harte strings — no model-internal state needed.
_FACTORED_HEAD_METRICS: tuple[str, ...] = (
    "quality_head",
    "bass_head",
)


def _factored_head_scores(ref_labels: list[str], est_labels: list[str]) -> dict[str, np.ndarray]:
    """Return per-frame match arrays for the quality and bass heads.

    Decodes each ref / est Harte string via ``encode_factored`` and compares
    the quality-head and bass-head indices independently. A frame whose ref
    label is unparseable contributes ``np.nan`` and is dropped from the WCSR
    denominator by ``mir_eval.chord.weighted_accuracy``.

    * ``quality_head``: 1.0 when ref.quality_idx == est.quality_idx, 0.0
      otherwise. N-vs-chord mismatches count as 0.
    * ``bass_head``: 1.0 on exact bass-slot match **on chord frames** (ref
      is not N). N frames contribute ``np.nan`` so they do not weight the
      per-song accuracy. The factored 0 (``same-as-root``) slot normalises
      a "no slash" label and an explicit ``/1``.
    """
    quality: list[float] = []
    bass: list[float] = []
    for ref, est in zip(ref_labels, est_labels, strict=True):
        ref_enc = encode_factored(ref)
        est_enc = encode_factored(est)
        if ref_enc is None:
            # Unparseable ground truth → drop from both metrics.
            quality.append(float("nan"))
            bass.append(float("nan"))
            continue
        _ref_root, ref_q, ref_b = ref_enc
        if est_enc is None:
            # Est unparseable → counted as a mismatch on both heads.
            quality.append(0.0)
            bass.append(0.0 if ref_q != QUALITY_N_INDEX else float("nan"))
            continue
        _est_root, est_q, est_b = est_enc
        quality.append(1.0 if est_q == ref_q else 0.0)
        if ref_q == QUALITY_N_INDEX:
            # Non-chord frame: bass metric is undefined — drop.
            bass.append(float("nan"))
        else:
            # Normalise: predicting BASS_N_INDEX on a chord frame is a
            # degenerate output; treat it as a mismatch unless the ref is
            # also N (handled above).
            est_b_norm = BASS_SAME_INDEX if est_b == BASS_N_INDEX else est_b
            bass.append(1.0 if est_b_norm == ref_b else 0.0)
    return {
        "quality_head": np.array(quality, dtype=np.float64),
        "bass_head": np.array(bass, dtype=np.float64),
    }


def _nan_weighted_accuracy(scores: np.ndarray, durations: np.ndarray) -> float:
    """``mir_eval.chord.weighted_accuracy`` with ``np.nan`` in ``scores`` dropped.

    ``mir_eval``'s own routine treats ``-1`` as "drop from denominator" (its
    ``X`` convention); we use ``nan`` for the factored per-head metrics so
    N-frame drops are explicit. Convert here.
    """
    if scores.size == 0:
        return 0.0
    nan_mask = np.isnan(scores)
    cleaned = np.where(nan_mask, -1.0, scores)
    return float(mir_eval.chord.weighted_accuracy(cleaned, durations))


def score_song(
    pred_intervals: np.ndarray,
    pred_labels: list[str],
    gt_intervals: np.ndarray,
    gt_labels: list[str],
) -> dict[str, float]:
    """Score one song across the 5 mir_eval chord metrics + 2 factored heads.

    Returns a dict with ``_METRIC_FUNCTIONS`` keys **plus** ``quality_head``
    and ``bass_head`` from the factored alphabet. All values are WCSR
    (duration-weighted frame accuracy).
    """
    results: dict[str, float] = {}
    all_metric_keys = tuple(_METRIC_FUNCTIONS) + _FACTORED_HEAD_METRICS
    if len(gt_intervals) == 0 or len(pred_intervals) == 0:
        return {m: 0.0 for m in all_metric_keys}

    common_intervals, ref_labels, est_labels = mir_eval.util.merge_labeled_intervals(
        gt_intervals, gt_labels, pred_intervals, pred_labels
    )
    durations = mir_eval.util.intervals_to_durations(common_intervals)
    for name, func in _METRIC_FUNCTIONS.items():
        scores = func(ref_labels, est_labels)
        wcsr = float(mir_eval.chord.weighted_accuracy(scores, durations))
        results[name] = wcsr
    head_scores = _factored_head_scores(ref_labels, est_labels)
    for name, arr in head_scores.items():
        results[name] = _nan_weighted_accuracy(arr, durations)
    return results


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _mean_std(values: list[float]) -> dict[str, float]:
    if not values:
        return {"mean": 0.0, "std": 0.0}
    if len(values) == 1:
        return {"mean": values[0], "std": 0.0}
    return {
        "mean": float(statistics.fmean(values)),
        "std": float(statistics.stdev(values)),
    }


# ---------------------------------------------------------------------------
# End-to-end eval
# ---------------------------------------------------------------------------


def run_eval(
    *,
    checkpoint: Path,
    eval_songs: Path,
    audio_cache: Path,
    shuffles: int,
    report_out: Path,
    per_song_floor: float,
    compare_provider: str | None,
    seed: int,
    model_version: str,
    per_song_bass_floor: float = 0.0,
    model: ChordNet2E1D | None = None,
    loader: AudioAndGtLoader | None = None,
    frame_to_time: Callable[[np.ndarray], np.ndarray] | None = None,
    # test seam: a fully-mocked (per-song predictions + per-song gt) stream.
    mock_predictions: dict[str, list[tuple[float, float, str]]] | None = None,
    mock_gt: dict[str, list[tuple[float, float, str]]] | None = None,
    hop_length: int = 2048,
    sample_rate: int = 22050,
) -> dict[str, object]:
    """Run eval with ``shuffles`` independent shuffle seeds and return the report dict.

    If ``mock_predictions`` + ``mock_gt`` are provided, we skip model/audio loading
    entirely — this is the CPU-only test seam.
    """
    songs, dataset_sha = _read_eval_songs(eval_songs)
    if not songs:
        raise ValueError(f"Eval manifest {eval_songs} has no songs.")

    rng = random.Random(seed)
    all_metric_keys = tuple(_METRIC_FUNCTIONS) + _FACTORED_HEAD_METRICS
    per_song: dict[str, dict[str, list[float]]] = {
        song.song_id: {m: [] for m in all_metric_keys} for song in songs
    }

    # Model loading (deferred to actually-needed path so tests can skip it).
    if mock_predictions is None:
        if model is None:
            ckpt = torch.load(checkpoint, map_location="cpu")
            model = ChordNet2E1D(output_mode=ckpt.get("output_mode", "factored"))
            model.load_state_dict(ckpt["model_state"])
        model.eval()
        if loader is None:
            loader = _default_loader

    for _shuffle_idx in range(shuffles):
        shuffle_seed = rng.randint(0, 2**31 - 1)
        shuffled_order = list(songs)
        shuffle_rng = random.Random(shuffle_seed)
        shuffle_rng.shuffle(shuffled_order)
        for song in shuffled_order:
            # ---- Ground truth ----
            if mock_gt is not None:
                gt = mock_gt[song.song_id]
            else:
                _audio, gt = loader(song, audio_cache)  # type: ignore[misc]

            gt_intervals, gt_labels = _gt_to_intervals(gt)

            # ---- Prediction ----
            if mock_predictions is not None:
                pred = mock_predictions[song.song_id]
                pred_intervals, pred_labels = _gt_to_intervals(pred)
            else:
                # CQT → model → segments. Requires PR-Y1.3 loader to be live.
                from .model.chordnet_2e1d import require_cqt_plan  # local import

                require_cqt_plan()  # raises with pointer to PR-Y1.3 if missing
                from .model.cqt_plan import PLAN, librosa_cqt  # type: ignore[import-not-found]

                cqt = librosa_cqt(_audio, PLAN)  # (T, n_bins)
                cqt_t = torch.from_numpy(cqt).float().unsqueeze(0)
                segments = model.predict_segments(cqt_t)  # type: ignore[union-attr]
                pred_intervals, pred_labels = _segments_to_intervals(
                    segments, hop_length=PLAN.hop_length, sample_rate=PLAN.sample_rate
                )

            scores = score_song(pred_intervals, pred_labels, gt_intervals, gt_labels)
            for metric, value in scores.items():
                per_song[song.song_id][metric].append(value)

    # Per-song floor check (ship gate).
    violations: list[dict[str, object]] = []
    bass_violations: list[dict[str, object]] = []
    for song_id, metric_values in per_song.items():
        majmin_values = metric_values["majmin"]
        if majmin_values:
            min_majmin = min(majmin_values)
            if min_majmin < per_song_floor:
                violations.append(
                    {
                        "song_id": song_id,
                        "min_majmin": min_majmin,
                        "all_majmin": majmin_values,
                    }
                )
        if per_song_bass_floor > 0.0:
            bass_values = metric_values.get("bass_head", [])
            if bass_values:
                min_bass = min(bass_values)
                if min_bass < per_song_bass_floor:
                    bass_violations.append(
                        {
                            "song_id": song_id,
                            "min_bass_head": min_bass,
                            "all_bass_head": bass_values,
                        }
                    )

    # Aggregate: mean + std per metric across the pooled (song × shuffle) values.
    aggregate: dict[str, dict[str, float]] = {}
    for metric in all_metric_keys:
        pooled: list[float] = []
        for song_id in per_song:
            pooled.extend(per_song[song_id][metric])
        aggregate[metric] = _mean_std(pooled)

    report: dict[str, object] = {
        "model_version": model_version,
        "alphabet_sha": ALPHABET_SHA,
        "cqt_plan_version": CQT_PLAN_VERSION,
        "dataset_sha": dataset_sha,
        "n_shuffles": shuffles,
        "seed": seed,
        "per_song": per_song,
        "aggregate": aggregate,
        "per_song_floor_majmin": per_song_floor,
        "per_song_floor_violated": violations,
        "per_song_bass_floor": per_song_bass_floor,
        "per_song_bass_floor_violated": bass_violations,
    }

    # Optional baseline delta (only the mir_eval metrics — baselines don't
    # publish factored head accuracies).
    if compare_provider == "klangio":
        baseline_path = (
            Path("apps/worker/tests/fixtures") / f"chord_eval_baseline_{compare_provider}.json"
        )
        if baseline_path.exists():
            baseline = json.loads(baseline_path.read_text())
            report["baseline_provider"] = compare_provider
            report["baseline_delta"] = {
                metric: aggregate[metric]["mean"]
                - float(baseline.get("aggregate", {}).get(metric, {}).get("mean", 0.0))
                for metric in _METRIC_FUNCTIONS
                if metric in aggregate
            }
        else:
            report["baseline_provider"] = compare_provider
            report["baseline_delta"] = None
            report["baseline_warning"] = f"Baseline fixture not found at {baseline_path}"

    # Write report + raise on floor violation(s).
    report_out.mkdir(parents=True, exist_ok=True)
    out_path = report_out / f"eval_{model_version}.json"
    out_path.write_text(json.dumps(report, indent=2, default=_json_default))

    reasons: list[str] = []
    if violations:
        reasons.append(
            f"MajMin floor {per_song_floor:.2%} violated on {len(violations)} song(s): "
            + ", ".join(
                f"{v['song_id']}={v['min_majmin']:.3f}"  # type: ignore[str-format]
                for v in violations
            )
        )
    if bass_violations:
        reasons.append(
            f"Bass floor {per_song_bass_floor:.2%} violated on "
            f"{len(bass_violations)} song(s): "
            + ", ".join(
                f"{v['song_id']}={v['min_bass_head']:.3f}"  # type: ignore[str-format]
                for v in bass_violations
            )
        )
    if reasons:
        raise EvalGateFailure("; ".join(reasons))

    return report


def _json_default(obj: object) -> object:
    """Fall-back JSON encoder for numpy scalars / pathlib / etc."""
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, Path):
        return str(obj)
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON-serializable")


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        run_eval(
            checkpoint=args.checkpoint,
            eval_songs=args.eval_songs,
            audio_cache=args.audio_cache,
            shuffles=args.shuffles,
            report_out=args.report_out,
            per_song_floor=args.per_song_floor,
            per_song_bass_floor=args.per_song_bass_floor,
            compare_provider=args.compare_provider,
            seed=args.seed,
            model_version=args.model_version,
        )
    except EvalGateFailure as exc:
        print(f"[eval-gate] FAIL: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
