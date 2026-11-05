"""Pinned CQT (Constant-Q Transform) plan for ChordNet Y1.

The browser-side chord overlay (served by ``apps/worker``) needs to produce
CQT frames that are **byte-for-byte compatible** with the ones the model was
trained on. If the two diverge — different hop length, different bin count,
different normalization — the trained convolutional stack sees input it has
never seen, and inference quality collapses even though every tensor shape
still matches.

This module is the single source of truth for those parameters:

- :class:`CQTPlan` — the frozen dataclass naming every value.
- :data:`PLAN` — the canonical Y1 instance (currently v2).
- :func:`librosa_cqt` — the thin wrapper every training-side consumer calls.
- :func:`serialize_plan` / :func:`deserialize_plan` — JSON round-trip used by
  ``apps/training/model/cqt-plan.v2.json`` and, in a later PR, by the
  browser-side CQT implementation that reads the same manifest.
  ``apps/training/model/cqt-plan.v1.json`` is retained as a legacy artifact
  for A/B comparison against the pre-red-team baseline; models trained on v1
  cannot be scored with v2 without a retrain. See ``MIGRATION_NOTE.md``.

Rationale for each pinned value (per the Y1 chord-model decision record,
research synthesis, and the alphabet+CQT red-team brief in the project
folder):

- ``sample_rate = 22050`` — matches the BTC / SheetSage2 training recipe and
  halves wall-clock vs 44.1 kHz with no measurable chord-eval regression.
- ``hop_length = 1024`` → 21.53 Hz frame rate at 22 050 Hz **(v2)**. The v1
  hop of 2048 (10.77 Hz) was flagged by the red team: SheetSage2 and
  ChordFormer both use ≤1024. Coarser hops smear chord boundaries between
  frames — most audible on fast tempi where a bar is only a few frames wide.
- ``fmin_hz = 32.70`` (C1) + ``n_bins = 144`` + ``bins_per_octave = 24`` —
  6 octaves of coverage (C1 … B6) at quarter-tone resolution. Spans the
  fundamental range of every instrument we train on (bass guitar up through
  piano high register) without wasting bins on inaudible subharmonics or
  the brittle top of the keyboard. The red team suggested bumping fmin to
  E1 to save 4 bins; we did NOT adopt that — jazz tracks in McGill Billboard
  have upright bass below E1, and 4 bins of savings is not worth truncating
  the fundamental range. See ``MIGRATION_NOTE.md``.
- ``log_amplitude = True`` + ``z_norm = "per_song"`` **(v2)** — amplitude-to-dB
  followed by per-clip (song-local) mean/std standardization. The v1 plan
  used ``"global"`` (corpus mean/std); the red team flagged that all three
  peer systems (SheetSage2, ChordFormer, BTC) use per-song, because dynamic
  range varies ~40 dB between acoustic folk and death-metal tracks and a
  global z-norm effectively crushes quiet material into near-zero inputs.
- ``hpf_hz = 70.0`` **(v2, NEW)** — high-pass filter applied *before* the
  CQT to remove sub-bass rumble that carries no pitch information for
  chord recognition. ChordFormer uses the same 70 Hz corner. Set to
  ``0.0`` to disable (reserved for diagnostic use).

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

    hop_length: int = 1024
    """Hop size in samples. At 22 050 Hz, 1024 ≈ 21.53 Hz frame rate (v2)."""

    fmin_hz: float = 32.70
    """Centre frequency of the lowest CQT bin. 32.70 Hz = C1."""

    n_bins: int = 144
    """Total number of CQT bins. 144 = 6 octaves at 24 bins/octave."""

    bins_per_octave: int = 24
    """Quarter-tone resolution (12 semitones × 2)."""

    log_amplitude: bool = True
    """If True, apply ``librosa.amplitude_to_db`` after the magnitude CQT."""

    z_norm: str = "per_song"
    """
    Standardization mode applied to the log-amplitude CQT.

    - ``"per_song"`` — standardize each clip independently against its own
      mean/std. v2 default. Matches SheetSage2 / ChordFormer / BTC and makes
      the input distribution insensitive to per-track loudness.
    - ``"per_track"`` — alias for ``"per_song"``; kept for backward-compat
      with any caller that typed the older name. Behaviour is identical.
    - ``"global"`` — v1 behaviour: subtract a corpus-level mean and divide
      by a corpus-level std. The actual (mean, std) pair is NOT part of this
      plan; it is written alongside the trainer snapshot. Retained for
      loading v1 manifests in A/B comparisons.
    - ``"none"`` — pass-through. Reserved for diagnostic use; the Y1
      recipe never ships with this value.
    """

    hpf_hz: float = 70.0
    """
    Corner frequency of the high-pass filter applied *before* the CQT (v2).

    ``0.0`` disables the filter. The default of 70 Hz matches ChordFormer:
    sub-bass energy below 70 Hz carries almost no chord-identifying
    information (the lowest piano C is ~32 Hz but chord recognition relies
    on the harmonic stack, not the rumbling fundamental). The filter is a
    4th-order Butterworth applied bidirectionally via ``sosfiltfilt`` so it
    is zero-phase — no latency, no smearing of transients.
    """

    version: str = "v2"
    """Plan schema version. Bump on ANY field change."""


# The canonical Y1 CQT plan. Every training-side module imports this; no code
# in this package should construct its own ``CQTPlan`` instance except in tests
# that specifically exercise non-default values.
PLAN = CQTPlan()


def apply_hpf(y: np.ndarray, plan: CQTPlan) -> np.ndarray:
    """Apply the plan's pre-CQT high-pass filter.

    A 4th-order Butterworth, applied zero-phase via ``sosfiltfilt`` so there
    is no group-delay bias on transients. When ``plan.hpf_hz <= 0`` the
    input is returned unchanged. When the corner is impractically close to
    Nyquist (``hpf_hz >= sample_rate / 2``) the call falls back to the
    unfiltered input rather than raising — the CQT itself will throw away
    the signal in that pathological case.

    This is a separate function so tests (and later the browser-side CQT
    port) can exercise the filter independently of librosa.

    Parameters
    ----------
    y
        Mono audio samples at ``plan.sample_rate`` Hz.
    plan
        The CQT plan whose ``hpf_hz`` corner to use.

    Returns
    -------
    numpy.ndarray
        A ``float32`` copy of ``y`` with frequencies below ``plan.hpf_hz``
        attenuated by ≥24 dB/octave. Shape and dtype match the input.
    """
    import numpy as np

    y = np.asarray(y, dtype=np.float32)
    if plan.hpf_hz <= 0.0:
        return y

    nyquist = plan.sample_rate / 2.0
    if plan.hpf_hz >= nyquist:
        return y

    from scipy.signal import butter, sosfiltfilt

    # 4th-order Butterworth, SOS form (numerically stabler than b/a for
    # low corners relative to the sample rate).
    sos = butter(4, plan.hpf_hz / nyquist, btype="highpass", output="sos")
    return sosfiltfilt(sos, y).astype(np.float32)


def librosa_cqt(y: np.ndarray, plan: CQTPlan = PLAN) -> np.ndarray:
    """Compute a log-amplitude, standardized CQT for ``y`` under ``plan``.

    v2 pipeline order:

    1. High-pass filter at ``plan.hpf_hz`` (``0`` disables; default 70 Hz).
    2. Magnitude CQT with ``plan.hop_length`` / ``plan.fmin_hz`` /
       ``plan.n_bins`` / ``plan.bins_per_octave``.
    3. Log-amplitude (``librosa.amplitude_to_db``) if ``plan.log_amplitude``.
    4. Standardization per ``plan.z_norm`` — ``per_song`` is the v2 default.

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
    This wrapper intentionally imports ``librosa``, ``numpy`` and ``scipy``
    lazily so importing :mod:`training.model.cqt_plan` is free for callers
    that only need the dataclass or the serializer (notably the browser-side
    JSON writer and every one of our unit tests).

    TODO(v3?): pre-emphasis filter. ChordFormer uses a 0.97 pre-emphasis
    before its spectrogram; we have not re-run the ablation for CQT inputs
    so v2 omits it. Revisit if WCSR plateaus below the Y1 target.
    """
    import librosa
    import numpy as np

    # 1. Pre-CQT high-pass (v2). No-op when plan.hpf_hz == 0.
    y_filt = apply_hpf(y, plan)

    # 2. Magnitude CQT. librosa returns (n_bins, n_frames); we transpose
    #    below so the on-disk layout matches the browser-side CQT.
    cqt = librosa.cqt(
        y=y_filt,
        sr=plan.sample_rate,
        hop_length=plan.hop_length,
        fmin=plan.fmin_hz,
        n_bins=plan.n_bins,
        bins_per_octave=plan.bins_per_octave,
    )
    mag = np.abs(cqt).astype(np.float32)

    # 3. Log-amplitude.
    if plan.log_amplitude:
        mag = librosa.amplitude_to_db(mag, ref=np.max).astype(np.float32)

    # 4. Standardization. v2 default is per_song (each clip against its own
    #    mean/std); v1 global is retained for loading legacy manifests.
    if plan.z_norm in ("per_song", "per_track"):
        mean = float(mag.mean())
        std = float(mag.std()) or 1.0
        mag = (mag - mean) / std
    elif plan.z_norm == "global":
        # v1 semantics: corpus-level (mean, std) are pinned at
        # trainer-snapshot time, not here. For the wrapper's purposes we
        # fall back to per-clip standardization (the trainer overrides
        # with its corpus statistics). Retained for backward-compat.
        mean = float(mag.mean())
        std = float(mag.std()) or 1.0
        mag = (mag - mean) / std
    elif plan.z_norm == "none":
        pass
    else:
        raise ValueError(f"Unknown z_norm mode: {plan.z_norm!r}")

    return mag.T.astype(np.float32)


def serialize_plan(plan: CQTPlan) -> dict[str, Any]:
    """Return the plan as a plain dict, ready to be written as JSON.

    A plan whose ``version`` is ``"v1"`` omits the v2-introduced ``hpf_hz``
    field: the v1 on-disk manifest was hashed over an 8-field payload, and
    stripping the field keeps the hash byte-stable across the v1 → v2
    code change. v2 (and later) plans include every dataclass field.
    """
    data = asdict(plan)
    if plan.version == "v1":
        data.pop("hpf_hz", None)
    return data


def deserialize_plan(data: dict[str, Any]) -> CQTPlan:
    """Rehydrate a :class:`CQTPlan` from a dict produced by :func:`serialize_plan`.

    Unknown fields raise ``TypeError`` so a schema drift fails loudly instead
    of silently dropping values.

    Backward-compat: a v1 payload (one that lacks the v2-introduced
    ``hpf_hz`` field) is accepted and rehydrated with ``hpf_hz = 0.0``
    (filter disabled) so the resulting plan reproduces the v1 behaviour
    byte-for-byte. The ``version`` field is taken from the payload, so a
    deserialized v1 plan still carries ``version == "v1"`` — tests use this
    to assert the loaded plan is NOT the current v2 default.
    """
    data = dict(data)
    # v1 manifests predate hpf_hz; fill in the v1 semantics (filter off).
    if data.get("version") == "v1" and "hpf_hz" not in data:
        data["hpf_hz"] = 0.0
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
