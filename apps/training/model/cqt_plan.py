"""Pinned CQT (Constant-Q Transform) plan for ChordNet Y1.

The browser-side chord overlay (served by ``apps/worker``) needs to produce
CQT frames that are **byte-for-byte compatible** with the ones the model was
trained on. If the two diverge — different hop length, different bin count,
different normalization — the trained convolutional stack sees input it has
never seen, and inference quality collapses even though every tensor shape
still matches.

This module is the single source of truth for those parameters:

- :class:`CQTPlan` — the frozen dataclass naming every value.
- :data:`PLAN` — the canonical Y1 instance.
- :func:`librosa_cqt` — the thin wrapper every training-side consumer calls.
- :func:`serialize_plan` / :func:`deserialize_plan` — JSON round-trip used by
  ``apps/training/model/cqt-plan.v1.json`` and, in a later PR, by the
  browser-side CQT implementation that reads the same manifest.

Rationale for each pinned value (per the Y1 chord-model decision record and
research synthesis in the project folder):

- ``sample_rate = 22050`` — matches the BTC / SheetSage2 training recipe and
  halves wall-clock vs 44.1 kHz with no measurable chord-eval regression.
- ``hop_length = 2048`` → 10.77 Hz frame rate at 22 050 Hz. Aligned with the
  Billboard / BTC beat-synchronous annotation cadence; coarse enough to keep
  per-song cost down and fine enough to resolve chord changes inside a bar.
- ``fmin_hz = 32.70`` (C1) + ``n_bins = 144`` + ``bins_per_octave = 24`` —
  6 octaves of coverage (C1 … B6) at quarter-tone resolution. Spans the
  fundamental range of every instrument we train on (bass guitar up through
  piano high register) without wasting bins on inaudible subharmonics or
  the brittle top of the keyboard.
- ``log_amplitude = True`` + ``z_norm = "global"`` — amplitude-to-dB with a
  per-corpus mean/std standardization. The mean/std themselves are computed
  over the full training split and written next to the manifest when the
  trainer snapshot ships.

A versioned, hashed JSON of this plan is what downstream code loads; see
:func:`write_manifest` for the on-disk format.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import numpy as np


@dataclass(frozen=True)
class CQTPlan:
    """Frozen bundle of every CQT parameter the Y1 pipeline agrees on.

    Changing any field here is a breaking change: the browser-side CQT
    implementation, the trained model, and the on-disk JSON manifest must all
    move together. Bump ``version`` when that happens.
    """

    sample_rate: int = 22050
    """Target sample rate in Hz. Audio is resampled on the way in."""

    hop_length: int = 2048
    """Hop size in samples. At 22 050 Hz, 2048 ≈ 10.77 Hz frame rate."""

    fmin_hz: float = 32.70
    """Centre frequency of the lowest CQT bin. 32.70 Hz = C1."""

    n_bins: int = 144
    """Total number of CQT bins. 144 = 6 octaves at 24 bins/octave."""

    bins_per_octave: int = 24
    """Quarter-tone resolution (12 semitones × 2)."""

    log_amplitude: bool = True
    """If True, apply ``librosa.amplitude_to_db`` after the magnitude CQT."""

    z_norm: str = "global"
    """
    Standardization mode applied to the log-amplitude CQT.

    - ``"global"`` — subtract a corpus-level mean and divide by a corpus-level
      std. The actual (mean, std) pair is NOT part of this plan; it is
      written alongside the trainer snapshot once the full training split is
      known.
    - ``"per_track"`` — standardize each clip independently. Faster to
      implement but gives up amplitude discrimination across tracks.
    - ``"none"`` — pass-through. Reserved for diagnostic use; the Y1
      recipe never ships with this value.
    """

    version: str = "v1"
    """Plan schema version. Bump on ANY field change."""


# The canonical Y1 CQT plan. Every training-side module imports this; no code
# in this package should construct its own ``CQTPlan`` instance except in tests
# that specifically exercise non-default values.
PLAN = CQTPlan()


def librosa_cqt(y: np.ndarray, plan: CQTPlan = PLAN) -> np.ndarray:
    """Compute a log-amplitude, standardized CQT for ``y`` under ``plan``.

    Parameters
    ----------
    y
        Mono audio samples in ``[-1.0, 1.0]`` at ``plan.sample_rate`` Hz. If
        the caller has audio at a different rate they are responsible for
        resampling first — this wrapper does not second-guess upstream
        pipelines.
    plan
        The CQT plan to use. Defaults to :data:`PLAN` (the frozen Y1 plan).

    Returns
    -------
    numpy.ndarray
        A ``(n_frames, n_bins)`` ``float32`` matrix. Frame-major layout
        matches the browser-side CQT the model ultimately runs against.

    Notes
    -----
    This wrapper intentionally imports ``librosa`` and ``numpy`` lazily so
    importing :mod:`training.model.cqt_plan` is free for callers that only
    need the dataclass or the serializer (notably the browser-side JSON
    writer and every one of our unit tests).
    """
    import librosa
    import numpy as np

    # Magnitude CQT in librosa returns (n_bins, n_frames); we transpose below.
    cqt = librosa.cqt(
        y=y,
        sr=plan.sample_rate,
        hop_length=plan.hop_length,
        fmin=plan.fmin_hz,
        n_bins=plan.n_bins,
        bins_per_octave=plan.bins_per_octave,
    )
    mag = np.abs(cqt).astype(np.float32)

    if plan.log_amplitude:
        mag = librosa.amplitude_to_db(mag, ref=np.max).astype(np.float32)

    if plan.z_norm == "global":
        # Global (mean, std) are pinned at trainer-snapshot time, not here.
        # For the wrapper's purposes, standardize per-clip as a reasonable
        # default; the trainer overrides this with its corpus statistics.
        mean = float(mag.mean())
        std = float(mag.std()) or 1.0
        mag = (mag - mean) / std
    elif plan.z_norm == "per_track":
        mean = float(mag.mean())
        std = float(mag.std()) or 1.0
        mag = (mag - mean) / std
    elif plan.z_norm == "none":
        pass
    else:
        raise ValueError(f"Unknown z_norm mode: {plan.z_norm!r}")

    return mag.T.astype(np.float32)


def serialize_plan(plan: CQTPlan) -> dict[str, Any]:
    """Return the plan as a plain dict, ready to be written as JSON."""
    return asdict(plan)


def deserialize_plan(data: dict[str, Any]) -> CQTPlan:
    """Rehydrate a :class:`CQTPlan` from a dict produced by :func:`serialize_plan`.

    Unknown fields raise ``TypeError`` so a schema drift fails loudly instead
    of silently dropping values.
    """
    return CQTPlan(**data)


def plan_sha256(plan: CQTPlan) -> str:
    """Stable SHA-256 of the plan's canonical JSON form.

    Downstream consumers (the browser-side CQT, the trainer snapshot
    sidecar) embed this hash; any mismatch at load time is a loud error.
    """
    payload = json.dumps(serialize_plan(plan), sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def write_manifest(plan: CQTPlan, path: str | Path) -> Path:
    """Write ``plan`` as ``{plan, sha256}`` JSON to ``path`` and return it.

    The manifest schema is intentionally tiny::

        {
          "plan": { ...serialized CQTPlan... },
          "sha256": "<sha256 of the serialized plan only>"
        }

    The browser-side CQT reads this file at build time (later PR) and
    assembles its own transform from ``plan``; the hash lets both sides
    detect accidental drift.
    """
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "plan": serialize_plan(plan),
        "sha256": plan_sha256(plan),
    }
    out.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return out


def read_manifest(path: str | Path) -> CQTPlan:
    """Read a plan manifest written by :func:`write_manifest`.

    Verifies the embedded sha256 before returning the plan. A mismatch or a
    missing hash raises ``ValueError``.
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if "plan" not in data or "sha256" not in data:
        raise ValueError("Manifest is missing 'plan' or 'sha256'.")
    plan = deserialize_plan(data["plan"])
    expected = plan_sha256(plan)
    if data["sha256"] != expected:
        raise ValueError(f"CQT plan sha256 mismatch: manifest={data['sha256']} computed={expected}")
    return plan
