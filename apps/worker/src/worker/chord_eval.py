"""PR-Y1.1: chord-recognition eval harness (importable module).

Invocation::

    python -m worker.chord_eval --provider klangio

The pytest-discoverable shim at ``apps/worker/tests/test_chord_eval.py``
re-exports ``run_eval`` and ``main`` from here so the manifest + cache + report
code lives in a single place; pytest collects the shim but finds no tests so
nothing is executed accidentally.

Reads the 20-song CC-licensed manifest, downloads any missing audio into a
gitignored cache dir (ONLY when ``CHORD_EVAL_FETCH=1`` — off by default so an
incautious run never mass-downloads), runs the provider against each track, and
writes a per-run JSON report under ``apps/worker/tests/chord_eval_reports/``.

Ground-truth comparison (``mir_eval``) is optional: if a row has
``ground_truth_lab`` pointing to a local .lab file, MajMin/sevenths/root metrics
are computed; otherwise only raw predictions + timing are recorded.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Manifest + reports live under apps/worker/tests/ (the shim's directory). The
# computed path is stable whether the worker is installed in editable mode or
# imported from the repo checkout.
_REPO_WORKER_ROOT = Path(__file__).resolve().parents[2]  # apps/worker/
MANIFEST_PATH = _REPO_WORKER_ROOT / "tests" / "fixtures" / "chord_eval_songs.json"
REPORTS_DIR = _REPO_WORKER_ROOT / "tests" / "chord_eval_reports"
DEFAULT_CACHE_DIR = _REPO_WORKER_ROOT / ".chord-eval-cache"


@dataclass
class EvalRow:
    manifest_id: str
    title: str
    artist: str
    genre: str
    license: str
    duration_sec: float
    provider: str
    provider_version: str
    model_ms: int
    num_segments: int
    key: str | None
    predicted_labels: list[str] = field(default_factory=list)
    mir_eval: dict[str, float] = field(default_factory=dict)
    error: str | None = None


@dataclass
class EvalReport:
    provider: str
    started_at: str
    finished_at: str
    manifest: str
    rows: list[EvalRow] = field(default_factory=list)
    totals: dict[str, Any] = field(default_factory=dict)


def _load_manifest(path: Path) -> list[dict[str, Any]]:
    with open(path) as fh:
        payload = json.load(fh)
    songs = payload.get("songs", [])
    if not isinstance(songs, list):
        raise ValueError(f"manifest {path} has no 'songs' list")
    return songs


def _download_if_missing(row: dict[str, Any], cache_dir: Path) -> Path | None:
    """Fetch the audio for ``row`` into ``cache_dir`` iff CHORD_EVAL_FETCH=1."""
    url = row.get("url", "")
    manifest_id = row.get("fma_id_or_jamendo_id", "unknown")
    target = cache_dir / f"{manifest_id}.audio"
    if target.exists():
        return target
    if os.environ.get("CHORD_EVAL_FETCH") != "1":
        return None
    import httpx  # noqa: PLC0415 — lazy so pytest collection doesn't force it

    cache_dir.mkdir(parents=True, exist_ok=True)
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
        r.raise_for_status()
        with open(target, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
    return target


def _segments_to_lab(result: Any) -> str:
    return "\n".join(
        f"{seg.start_sec:.6f}\t{seg.end_sec:.6f}\t{seg.label}" for seg in result.segments
    )


def _mir_eval_row(predicted_lab_text: str, ground_truth_path: Path) -> dict[str, float]:
    """Compute MajMin / sevenths / root metrics via ``mir_eval`` if installed."""
    try:
        from mir_eval import chord as mir_chord  # noqa: PLC0415
        from mir_eval.io import load_labeled_intervals  # noqa: PLC0415
    except ImportError:
        return {"_skipped": 1.0, "_reason": 0.0}  # pragma: no cover — optional dep

    ref_intervals, ref_labels = load_labeled_intervals(str(ground_truth_path))
    tmp = ground_truth_path.with_suffix(".pred.lab")
    tmp.write_text(predicted_lab_text)
    est_intervals, est_labels = load_labeled_intervals(str(tmp))
    out: dict[str, float] = {}
    for metric in ("root", "majmin", "sevenths"):
        try:
            scored = mir_chord.evaluate(  # type: ignore[attr-defined]
                ref_intervals, ref_labels, est_intervals, est_labels, [metric]
            )
            out[metric] = float(scored[metric][0])
        except Exception as exc:  # noqa: BLE001
            out[f"{metric}_error_len"] = float(len(str(exc)))
    return out


def _row_for_error(row: dict[str, Any], source: Any, error: str, model_ms: int = 0) -> EvalRow:
    return EvalRow(
        manifest_id=row.get("fma_id_or_jamendo_id", "unknown"),
        title=row.get("title", ""),
        artist=row.get("artist", ""),
        genre=row.get("genre", ""),
        license=row.get("license", ""),
        duration_sec=float(row.get("duration_sec", 0.0)),
        provider=getattr(source, "__class__", type(source)).__name__,
        provider_version="",
        model_ms=model_ms,
        num_segments=0,
        key=None,
        error=error,
    )


def run_eval(
    source: Any,
    songs_manifest: Path = MANIFEST_PATH,
    cache_dir: Path = DEFAULT_CACHE_DIR,
) -> EvalReport:
    """Run the eval harness end-to-end. Does NOT fetch audio unless CHORD_EVAL_FETCH=1."""
    songs = _load_manifest(songs_manifest)
    started_at = dt.datetime.now(dt.UTC).isoformat()
    rows: list[EvalRow] = []
    total_ms = 0
    ok = 0
    skipped = 0

    for row in songs:
        try:
            audio_path = _download_if_missing(row, cache_dir)
        except Exception as exc:  # noqa: BLE001
            rows.append(_row_for_error(row, source, f"download_failed: {exc}"))
            continue

        if audio_path is None:
            skipped += 1
            rows.append(
                _row_for_error(
                    row,
                    source,
                    "skipped_no_fetch (set CHORD_EVAL_FETCH=1 to download)",
                )
            )
            continue

        t0 = time.monotonic()
        try:
            result = source.recognize(audio_path, stem="instrumental")
        except Exception as exc:  # noqa: BLE001
            rows.append(
                _row_for_error(
                    row,
                    source,
                    f"recognize_failed: {exc}",
                    model_ms=int((time.monotonic() - t0) * 1000),
                )
            )
            continue

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        total_ms += elapsed_ms
        ok += 1

        mir_scores: dict[str, float] = {}
        gt = row.get("ground_truth_lab")
        if gt:
            gt_path = Path(gt)
            if gt_path.exists():
                mir_scores = _mir_eval_row(_segments_to_lab(result), gt_path)

        rows.append(
            EvalRow(
                manifest_id=row.get("fma_id_or_jamendo_id", "unknown"),
                title=row.get("title", ""),
                artist=row.get("artist", ""),
                genre=row.get("genre", ""),
                license=row.get("license", ""),
                duration_sec=float(row.get("duration_sec", 0.0)),
                provider=result.provider,
                provider_version=result.provider_version,
                model_ms=elapsed_ms,
                num_segments=len(result.segments),
                key=result.key,
                predicted_labels=[seg.label for seg in result.segments],
                mir_eval=mir_scores,
            )
        )

    finished_at = dt.datetime.now(dt.UTC).isoformat()
    return EvalReport(
        provider=rows[0].provider if rows else "unknown",
        started_at=started_at,
        finished_at=finished_at,
        manifest=str(songs_manifest),
        rows=rows,
        totals={
            "songs_total": len(songs),
            "songs_ok": ok,
            "songs_skipped": skipped,
            "total_model_ms": total_ms,
        },
    )


def _write_report(report: EvalReport, provider_name: str) -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    out = REPORTS_DIR / f"{provider_name}-{ts}.json"
    with open(out, "w") as fh:
        json.dump(asdict(report), fh, indent=2, default=str)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the chord-recognition eval harness (PR-Y1.1)."
    )
    parser.add_argument(
        "--provider",
        default=os.environ.get("CHORDS_PROVIDER", "klangio"),
        help="ChordSource provider name (klangio | replicate | internal).",
    )
    parser.add_argument(
        "--manifest", type=Path, default=MANIFEST_PATH, help="chord_eval_songs.json path"
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=DEFAULT_CACHE_DIR,
        help="Local cache dir (gitignored). Downloads happen when CHORD_EVAL_FETCH=1.",
    )
    args = parser.parse_args(argv)

    from .chord_source import get_chord_source  # noqa: PLC0415

    source = get_chord_source(args.provider)
    report = run_eval(source, args.manifest, args.cache_dir)
    out = _write_report(report, args.provider)
    print(f"Wrote report -> {out}")
    print(json.dumps(report.totals, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
