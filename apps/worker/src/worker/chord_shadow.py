"""Chord shadow-compare (24A plan step B4): run the self-hosted BTC provider beside Klangio
and record ONLY how much the two agree.

Off by default. ``CHORDS_SHADOW_BTC`` turns it on only when it is exactly ``1`` or ``true``
(case-insensitive, read at call time by ``pipeline._chords_shadow_enabled``). With the flag
off the pipeline calls the chord hook exactly as before and this module is never imported.

When on, and only after Klangio returned a result for this job, the pipeline hands this
module the SAME audio file Klangio got plus the Klangio ``ChordResult`` already in hand.
Nothing here calls Klangio or touches its ledger, quota or breaker.

  * BTC runs in a CHILD PROCESS (``python -m <pkg>.chord_shadow <audio> <out.json>``), so the
    wall-clock cap is real: on timeout the child is killed and its memory (~350-430 MB for a
    3-5 min song, up to ~842 MB on 20 min per #528) goes back to the OS. A thread could not
    be stopped and would keep its RSS in the worker for the rest of the process life.
  * Bounds: ``SHADOW_TIMEOUT_SEC`` = 60 s wall clock (BTC measured 0.7-2.5 s for 3-5 min on
    2 cores, plus ~1-2 s of child start-up and weight checks: a >10x margin that still caps
    what a stuck run can add to a job). ``SHADOW_MAX_AUDIO_SEC`` = 600 s: longer input is
    skipped (Klangio's own cap is 300 s by default, so this only bites if
    ``CHORDS_MAX_AUDIO_SEC`` is raised; it keeps the child's RSS well under the 20-min peak).
  * Never raises. Any failure (missing weights, child crash, timeout, bad output) logs one
    WARN ``chords_shadow_failed`` and returns ``{"chords_shadow": {"ok": False,
    "error_class": <class name>}}``: no message text, so nothing user- or path-derived lands
    in job_events. The caller merges the returned dict into the EXISTING extracting/completed
    row's detail (B-8c pattern: no new row, stage or phase; the web API drops ``detail``).
  * Agreement is time-weighted MajMin (and sevenths) in [0, 1], the mir_eval
    ``chord.majmin`` / ``chord.sevenths`` definitions re-implemented in pure Python (mir_eval
    is dev-only). Klangio is the reference. The payload carries numbers and provider versions
    only: no chord labels, no audio reference, no user data.
"""

from __future__ import annotations

import bisect
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterable, Sequence
from pathlib import Path

from .logger import log_structured

SHADOW_TIMEOUT_SEC = 60.0
SHADOW_MAX_AUDIO_SEC = 600.0
EVENT_KEY = "chords_shadow"


# --------------------------------------------------------------------------- comparator
_PITCH = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_LABEL_RE = re.compile(r"^([A-G])([#b]?)(?::([^/]*))?(?:/.*)?$")

# Triad class of each Harte quality, i.e. mir_eval's first 8 semitones: only maj/min count.
_MAJMIN = {
    "maj": "maj",
    "7": "maj",
    "maj7": "maj",
    "maj6": "maj",
    "9": "maj",
    "maj9": "maj",
    "11": "maj",
    "13": "maj",
    "add9": "maj",
    "add11": "maj",
    "add6": "maj",
    "min": "min",
    "min6": "min",
    "min7": "min",
    "minmaj7": "min",
    "min9": "min",
}
# mir_eval sevenths: the 12-semitone bitmap (extensions above the octave dropped) must be one
# of maj / min / maj7 / 7 / min7.
_SEVENTHS = {
    "maj": "maj",
    "add9": "maj",
    "add11": "maj",
    "min": "min",
    "7": "7",
    "9": "7",
    "11": "7",
    "13": "7",
    "maj7": "maj7",
    "maj9": "maj7",
    "min7": "min7",
    "min9": "min7",
}
_NO_CHORD = "N"


def reduce_label(label: str, table: dict[str, str]) -> tuple | str | None:
    """``"N"`` for no-chord; ``(pitch_class, class)`` for a chord the table scores;
    ``("other", pitch_class, quality)`` for a chord it does not; ``None`` for X / unparseable.
    Inversions are ignored (mir_eval majmin / sevenths compare root + quality only)."""
    label = (label or "").strip()
    if label == _NO_CHORD:
        return _NO_CHORD
    m = _LABEL_RE.match(label)
    if not m:
        return None
    pc = (_PITCH[m.group(1)] + {"#": 1, "b": -1, "": 0}[m.group(2)]) % 12
    quality = m.group(3) if m.group(3) else "maj"
    cls = table.get(quality)
    return (pc, cls) if cls else ("other", pc, quality)


def _label_at(starts: list[float], segs: Sequence[tuple], t: float) -> str:
    i = bisect.bisect_right(starts, t) - 1
    if i >= 0 and segs[i][0] <= t < segs[i][1]:
        return segs[i][2]
    return _NO_CHORD


def _clean(segments: Iterable[Sequence]) -> list[tuple[float, float, str]]:
    out = []
    for s in segments:
        start, end, label = float(s[0]), float(s[1]), str(s[2])
        if end > start:
            out.append((start, end, label))
    out.sort(key=lambda x: x[0])
    return out


def agreement(
    reference: Iterable[Sequence], estimate: Iterable[Sequence], table: dict[str, str]
) -> float | None:
    """Time-weighted agreement of ``estimate`` against ``reference`` in [0, 1], or ``None``
    when no reference time is scorable. Segments are ``(start, end, label)``.

    Scored span = the reference's [first start, last end]; any gap in either sequence counts
    as N (mir_eval pads the estimate the same way). Reference time whose label the table does
    not score (dim, sus, X, ...) is left out of numerator AND denominator; ``N`` vs ``N`` is a
    match, ``N`` vs a chord is not."""
    ref = _clean(reference)
    est = _clean(estimate)
    if not ref:
        return None
    lo, hi = ref[0][0], max(e for _s, e, _l in ref)
    cuts = {lo, hi}
    for s, e, _l in (*ref, *est):
        for t in (s, e):
            if lo < t < hi:
                cuts.add(t)
    bounds = sorted(cuts)
    ref_starts = [s for s, _e, _l in ref]
    est_starts = [s for s, _e, _l in est]
    hit = total = 0.0
    for a, b in zip(bounds, bounds[1:], strict=False):
        mid = (a + b) / 2.0
        r = reduce_label(_label_at(ref_starts, ref, mid), table)
        if r is None or (isinstance(r, tuple) and r[0] == "other"):
            continue
        dur = b - a
        total += dur
        if reduce_label(_label_at(est_starts, est, mid), table) == r:
            hit += dur
    if total <= 0.0:
        return None
    return hit / total


def majmin_agreement(reference, estimate) -> float | None:
    return agreement(reference, estimate, _MAJMIN)


def sevenths_agreement(reference, estimate) -> float | None:
    return agreement(reference, estimate, _SEVENTHS)


# --------------------------------------------------------------------------- BTC child
class ShadowSkipped(Exception):
    """Not a failure: the input is outside the shadow bounds."""


class BtcShadowChildFailed(RuntimeError):
    """The child exited without a usable result."""


def _child_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(p for p in sys.path if p)
    return env


def run_btc_child(audio_path: str, timeout_sec: float = SHADOW_TIMEOUT_SEC) -> dict:
    """Run BTC on ``audio_path`` in a child process. Returns the child's JSON (segments,
    provider_version, model_ms). Raises ``subprocess.TimeoutExpired`` (child killed) or
    ``BtcShadowChildFailed`` / the child's own error class name in the message."""
    with tempfile.TemporaryDirectory(prefix="sl_chordshadow_") as tmp:
        out = os.path.join(tmp, "btc.json")
        proc = subprocess.run(
            [sys.executable, "-m", f"{__package__}.chord_shadow", str(audio_path), out],
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_sec,
            check=False,
        )
        data = None
        if os.path.exists(out):
            with open(out, encoding="utf-8") as fh:
                data = json.load(fh)
        if proc.returncode != 0 or not isinstance(data, dict) or "segments" not in data:
            cls = data.get("error_class") if isinstance(data, dict) else None
            raise BtcShadowChildFailed(str(cls or f"exit {proc.returncode}"))
        return data


def shadow_compare(
    job_id: str,
    audio_path: str,
    klangio_result,
    duration_sec: float | None,
    *,
    runner=None,
    timeout_sec: float = SHADOW_TIMEOUT_SEC,
) -> dict | None:
    """``{"chords_shadow": {...}}`` to merge into the extracting/completed detail, or ``None``
    when skipped. NEVER raises and never reads or writes anything Klangio-side."""
    t0 = time.monotonic()
    try:
        dur = float(duration_sec or 0.0) or float(getattr(klangio_result, "duration_sec", 0) or 0)
        if dur > SHADOW_MAX_AUDIO_SEC:
            raise ShadowSkipped("too_long")
        data = (runner or run_btc_child)(audio_path, timeout_sec)
        btc_ms = int((time.monotonic() - t0) * 1000)
        ref = [(s.start_sec, s.end_sec, s.label) for s in klangio_result.segments]
        est = [tuple(s[:3]) for s in data["segments"]]
        majmin = majmin_agreement(ref, est)
        sevenths = sevenths_agreement(ref, est)
        payload = {
            "ok": True,
            "majmin": None if majmin is None else round(majmin, 4),
            "sevenths": None if sevenths is None else round(sevenths, 4),
            "btc_ms": btc_ms,
            "btc_model_ms": int(data.get("model_ms") or 0),
            "duration_sec": round(dur, 1),
            "klangio_version": str(getattr(klangio_result, "provider_version", ""))[:64],
            "btc_version": str(data.get("provider_version") or "")[:64],
        }
        log_structured(
            "INFO",
            "chords_shadow_complete",
            job_id=job_id,
            majmin=payload["majmin"],
            sevenths=payload["sevenths"],
            btc_ms=btc_ms,
        )
        return {EVENT_KEY: payload}
    except ShadowSkipped as skip:
        log_structured(
            "INFO",
            "chords_shadow_skipped",
            job_id=job_id,
            reason=str(skip),
            duration_sec=round(float(duration_sec or 0.0), 1),
        )
        return None
    except Exception as exc:  # noqa: BLE001 — shadow must never affect the job
        name = type(exc).__name__
        if isinstance(exc, BtcShadowChildFailed) and str(exc).isidentifier():
            name = str(exc)
        log_structured("WARN", "chords_shadow_failed", job_id=job_id, error_class=name)
        return {EVENT_KEY: {"ok": False, "error_class": name[:64]}}


# --------------------------------------------------------------------------- child entry
def _child_main(argv: list[str]) -> int:
    audio, out = argv[0], argv[1]
    try:
        from .chord_providers.btc import BtcChordSource  # noqa: PLC0415 — child only

        result = BtcChordSource().recognize(Path(audio))
        data = {
            "segments": [[s.start_sec, s.end_sec, s.label] for s in result.segments],
            "provider_version": result.provider_version,
            "model_ms": result.model_ms,
        }
        code = 0
    except Exception as exc:  # noqa: BLE001 — reported to the parent by class name only
        data = {"error_class": type(exc).__name__}
        code = 1
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    return code


if __name__ == "__main__":  # pragma: no cover — exercised via run_btc_child
    sys.exit(_child_main(sys.argv[1:]))
