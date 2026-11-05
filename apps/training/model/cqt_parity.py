"""librosa ↔ browser CQT parity fixture generator (PR-Y1.5b).

The red-team pre-mortem (``claude/phase-2-y1-chord-model-premortem.md``)
flagged CQT parity between the training-side librosa pipeline and the
browser-side WASM/WebGPU pipeline as the single highest-severity
load-bearing assumption of the whole chord-model program. The failure
mode: train the model on librosa CQT frames, deploy the browser-side
Y variant, discover (or worse — fail to discover) that the browser CQT
differs by > 1 % in log-magnitude per bin, and the model silently
predicts garbage for every user.

The way we de-risk this before Y1.6 opens is to:

1. Freeze a small, deterministic set of audio clips here, in Python.
2. Run them through ``librosa.cqt`` under the Y1 pinned plan.
3. Save ``(audio.wav, cqt_frames.npy, cqt.sha256)`` fixtures to
   ``apps/training/tests/fixtures/cqt_parity/``, with a manifest.
4. Hand those fixtures to the browser side (PR-Y1.6) as ground truth —
   the browser must reproduce every fixture within tolerance or the
   browser CQT is wrong.

This module is the one-way librosa → fixture exporter. No browser-side
code lives here (the browser cannot run in Python); the parity assertion
runs in PR-Y1.6's JS test suite against the fixtures this file emits.

CQT plan dependency (PR-Y1.3, parallel):
    When ``training.model.cqt_plan`` is importable we delegate to its
    frozen ``PLAN`` and ``librosa_cqt(...)`` wrapper. When it isn't yet,
    we fall back to a local mirror of the Y1 plan constants so a fresh
    checkout off ``v3/main`` can still generate (and verify) the same
    fixtures byte-for-byte. The two paths MUST produce identical bytes;
    ``test_cqt_parity.py`` asserts that invariant whenever both are
    available.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------------------
# CQT plan: prefer PR-Y1.3's frozen plan, fall back to local mirror.
# ---------------------------------------------------------------------------

# Local mirror of the Y1 CQT plan. If PR-Y1.3 hasn't landed on this branch
# yet we use these constants directly; otherwise we assert they equal the
# frozen ``PLAN``. Any drift is a hard error (``verify_plan_mirror``).
_LOCAL_PLAN: dict[str, Any] = {
    "sample_rate": 22050,
    "hop_length": 2048,
    "fmin_hz": 32.70,
    "n_bins": 144,
    "bins_per_octave": 24,
    "log_amplitude": True,
    "z_norm": "global",
    "version": "v1",
}

try:
    # noqa: F401 — imported for the verify_plan_mirror() check below.
    from .cqt_plan import PLAN as _FROZEN_PLAN

    _CQT_PLAN_AVAILABLE: bool = True
except ImportError:
    _FROZEN_PLAN = None  # type: ignore[assignment]
    _CQT_PLAN_AVAILABLE = False


def verify_plan_mirror() -> None:
    """Assert the local mirror matches PR-Y1.3's frozen plan when available.

    Raises ``RuntimeError`` on drift. Silent no-op when PR-Y1.3 hasn't
    landed yet. Called at the top of ``compute_cqt`` so any drift blows
    up before fixtures are generated.
    """
    if not _CQT_PLAN_AVAILABLE:
        return
    for key, local_value in _LOCAL_PLAN.items():
        frozen_value = getattr(_FROZEN_PLAN, key)
        if local_value != frozen_value:
            raise RuntimeError(
                f"CQT plan mirror drift: {key}={local_value!r} locally, "
                f"{frozen_value!r} in cqt_plan.PLAN. PR-Y1.5b's mirror "
                f"must track PR-Y1.3's frozen plan byte-for-byte."
            )


# ---------------------------------------------------------------------------
# Deterministic synthetic clip bank.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClipSpec:
    """Specification of one deterministic synthetic clip in the fixture set."""

    name: str
    """Short identifier, used as the on-disk filename stem."""

    description: str
    """Human-readable description for the manifest."""

    duration_sec: float
    """Clip length in seconds."""

    kind: str
    """One of: ``sine``, ``sine_chord``, ``white_noise``, ``pink_noise``,
    ``sweep``, ``silence``, ``mixed``. The kind drives the renderer below."""

    frequencies: tuple[float, ...] = ()
    """Hz values for ``sine`` / ``sine_chord`` / ``mixed``."""

    amplitude: float = 0.3
    """Peak amplitude (``[-1, 1]``). Default well below clipping."""

    seed: int = 0
    """RNG seed for stochastic kinds (noise). Pinned per clip for determinism."""


# The 20-clip parity bank. Every spec is pinned so regenerating the fixtures
# from a clean checkout produces identical SHA-256 digests. Mixed-content
# clips are listed last so the easier single-tone cases fail first if
# anything is wrong.
CLIP_BANK: tuple[ClipSpec, ...] = (
    # ----- Single sine tones: A4 across a few octaves (baseline) -----
    ClipSpec("sine_a2_110hz", "Pure A2 sine (110 Hz, low register)", 2.0, "sine", (110.0,)),
    ClipSpec("sine_a3_220hz", "Pure A3 sine (220 Hz)", 2.0, "sine", (220.0,)),
    ClipSpec("sine_a4_440hz", "Pure A4 sine (440 Hz, concert pitch)", 2.0, "sine", (440.0,)),
    ClipSpec("sine_a5_880hz", "Pure A5 sine (880 Hz)", 2.0, "sine", (880.0,)),
    ClipSpec("sine_a6_1760hz", "Pure A6 sine (1760 Hz, upper register)", 2.0, "sine", (1760.0,)),
    # ----- Edge-of-range probes -----
    ClipSpec("sine_c1_32_70hz", "Pure C1 sine (32.70 Hz, CQT fmin)", 2.0, "sine", (32.70,)),
    ClipSpec("sine_b6_1975_53hz", "Pure B6 sine (1975.53 Hz, CQT fmax)", 2.0, "sine", (1975.53,)),
    # ----- Quarter-tone probes (should resolve across bins_per_octave=24) -----
    ClipSpec(
        "sine_quartertone_a4_sharp",
        "A4 + 50 cents (453.08 Hz, inter-bin quarter-tone)",
        2.0,
        "sine",
        (453.08,),
    ),
    # ----- Triadic chord stacks (what the model actually sees) -----
    ClipSpec(
        "chord_c_major_root",
        "C major triad in root position (C4, E4, G4)",
        2.0,
        "sine_chord",
        (261.63, 329.63, 392.00),
    ),
    ClipSpec(
        "chord_a_minor_root",
        "A minor triad in root position (A3, C4, E4)",
        2.0,
        "sine_chord",
        (220.00, 261.63, 329.63),
    ),
    ClipSpec(
        "chord_g7_root",
        "G7 chord in root position (G3, B3, D4, F4)",
        2.0,
        "sine_chord",
        (196.00, 246.94, 293.66, 349.23),
    ),
    ClipSpec(
        "chord_fmaj7_rootless",
        "F maj7 without root (A3, C4, E4)",
        2.0,
        "sine_chord",
        (220.00, 261.63, 329.63),
    ),
    # ----- Noise clips -----
    ClipSpec("white_noise", "White noise, uniform in [-0.3, 0.3]", 2.0, "white_noise", seed=42),
    ClipSpec("pink_noise", "1/f pink noise, normalised to 0.3 peak", 2.0, "pink_noise", seed=7),
    ClipSpec("silence", "Pure silence (all zeros)", 1.0, "silence"),
    # ----- Linear sweep -----
    ClipSpec(
        "chirp_sweep_55_880hz",
        "Linear frequency sweep 55 Hz → 880 Hz over 2 s",
        2.0,
        "sweep",
        (55.0, 880.0),
    ),
    # ----- Mixed content (tone + noise) -----
    ClipSpec(
        "mixed_a4_plus_noise",
        "A4 sine (440 Hz) + white noise at 0.1 amplitude",
        2.0,
        "mixed",
        (440.0,),
        seed=1,
    ),
    ClipSpec(
        "mixed_c_major_plus_noise",
        "C major triad + white noise at 0.05 amplitude",
        2.0,
        "mixed",
        (261.63, 329.63, 392.00),
        seed=2,
    ),
    # ----- Short clips (tests boundary framing) -----
    ClipSpec(
        "sine_short_440hz", "A4 sine, 0.5 s (short clip; few CQT frames)", 0.5, "sine", (440.0,)
    ),
    ClipSpec(
        "silence_short",
        "Short silence (0.3 s; tests sub-second CQT framing)",
        0.3,
        "silence",
    ),
)


# ---------------------------------------------------------------------------
# Synthetic renderers.
# ---------------------------------------------------------------------------


def render_clip(spec: ClipSpec) -> np.ndarray:
    """Render one clip spec to a mono ``float32`` numpy array at 22 050 Hz.

    All renderers are deterministic — stochastic kinds seed a fresh RNG
    from ``spec.seed``. The returned array is in ``[-1, 1]`` with peak
    amplitude ``spec.amplitude`` (except silence).
    """
    sr = _LOCAL_PLAN["sample_rate"]
    n = int(round(spec.duration_sec * sr))
    t = np.arange(n, dtype=np.float32) / float(sr)

    if spec.kind == "silence":
        return np.zeros(n, dtype=np.float32)

    if spec.kind == "sine":
        (freq,) = spec.frequencies
        y = np.sin(2.0 * np.pi * freq * t, dtype=np.float32)
        return (y * spec.amplitude).astype(np.float32)

    if spec.kind == "sine_chord":
        # Equal-amplitude sum of sinusoids, rescaled to the spec peak.
        y = np.zeros(n, dtype=np.float64)
        for freq in spec.frequencies:
            y += np.sin(2.0 * np.pi * freq * t.astype(np.float64))
        peak = float(np.max(np.abs(y))) or 1.0
        y = (y / peak) * spec.amplitude
        return y.astype(np.float32)

    if spec.kind == "white_noise":
        rng = np.random.default_rng(spec.seed)
        y = rng.uniform(-1.0, 1.0, size=n).astype(np.float32)
        return (y * spec.amplitude).astype(np.float32)

    if spec.kind == "pink_noise":
        # Voss-McCartney approximation: cumulative sum of white noise,
        # filtered to 1/f, deterministic for a given seed.
        rng = np.random.default_rng(spec.seed)
        white = rng.standard_normal(n).astype(np.float64)
        # Simple 1/f coloration via FFT magnitude shaping.
        spec_fft = np.fft.rfft(white)
        freqs = np.fft.rfftfreq(n, d=1.0 / sr)
        freqs[0] = 1.0  # avoid div-by-zero at DC
        spec_fft = spec_fft / np.sqrt(freqs)
        y = np.fft.irfft(spec_fft, n=n).astype(np.float32)
        peak = float(np.max(np.abs(y))) or 1.0
        y = (y / peak) * spec.amplitude
        return y.astype(np.float32)

    if spec.kind == "sweep":
        f0, f1 = spec.frequencies
        # Linear chirp: f(t) = f0 + (f1 - f0) * t / T → phase = integral.
        T = spec.duration_sec
        phase = 2.0 * np.pi * (f0 * t + (f1 - f0) * t * t / (2.0 * T))
        y = np.sin(phase.astype(np.float64)).astype(np.float32)
        return (y * spec.amplitude).astype(np.float32)

    if spec.kind == "mixed":
        # Deterministic rebuild of a sine (or chord) + scaled white noise.
        if len(spec.frequencies) == 1:
            (freq,) = spec.frequencies
            tone = np.sin(2.0 * np.pi * freq * t, dtype=np.float32) * spec.amplitude
        else:
            tone = np.zeros(n, dtype=np.float64)
            for freq in spec.frequencies:
                tone += np.sin(2.0 * np.pi * freq * t.astype(np.float64))
            peak = float(np.max(np.abs(tone))) or 1.0
            tone = ((tone / peak) * spec.amplitude).astype(np.float32)
        rng = np.random.default_rng(spec.seed)
        noise = rng.uniform(-1.0, 1.0, size=n).astype(np.float32) * 0.1
        return (tone + noise).astype(np.float32)

    raise ValueError(f"Unknown clip kind: {spec.kind!r}")


# ---------------------------------------------------------------------------
# CQT computation with plan-mirror safety.
# ---------------------------------------------------------------------------


def compute_cqt(y: np.ndarray) -> np.ndarray:
    """Compute the log-amplitude, globally standardized CQT per the Y1 plan.

    Returns a ``(n_frames, n_bins)`` ``float32`` matrix. Verifies the
    local plan mirror against PR-Y1.3's frozen plan when the latter is
    importable, so plan drift blows up here instead of silently in a
    browser.
    """
    verify_plan_mirror()
    import librosa  # lazy — keeps import-time cheap for the dataclass bank

    plan = _LOCAL_PLAN
    cqt = librosa.cqt(
        y=y,
        sr=plan["sample_rate"],
        hop_length=plan["hop_length"],
        fmin=plan["fmin_hz"],
        n_bins=plan["n_bins"],
        bins_per_octave=plan["bins_per_octave"],
    )
    mag = np.abs(cqt).astype(np.float32)
    if plan["log_amplitude"]:
        mag = librosa.amplitude_to_db(mag, ref=np.max).astype(np.float32)
    # Global/per-track standardization. Matches cqt_plan.librosa_cqt's
    # per-clip default when global corpus stats aren't available.
    mean = float(mag.mean())
    std = float(mag.std()) or 1.0
    mag = ((mag - mean) / std).astype(np.float32)
    # librosa returns (n_bins, n_frames); the browser consumes (n_frames,
    # n_bins) (frame-major, matching the model input contract).
    return mag.T.astype(np.float32)


# ---------------------------------------------------------------------------
# Fixture writer.
# ---------------------------------------------------------------------------


def _audio_sha256(y: np.ndarray) -> str:
    """SHA-256 of the raw float32 audio bytes (little-endian, native layout)."""
    return hashlib.sha256(y.astype(np.float32, copy=False).tobytes()).hexdigest()


def _write_float32_wav(path: Path, y: np.ndarray, sr: int) -> None:
    """Write ``y`` as a deterministic 32-bit float PCM WAV.

    Avoids soundfile's default ``PEAK`` chunk — that chunk embeds a
    wall-clock timestamp and makes two consecutive writes of the same
    audio produce different WAV bytes. The resulting file is still a
    standards-compliant WAVE with ``fmt`` (format=3, float) and
    ``data`` chunks; every mainstream decoder (soundfile, scipy.io.wavfile,
    Web Audio) reads it correctly.
    """
    import struct

    pcm = y.astype("<f4", copy=False).tobytes()
    data_size = len(pcm)
    # fmt chunk: 16 bytes, format 3 (IEEE float), 1 channel, sr, byte-rate,
    # block-align, bits/sample.
    fmt_chunk = struct.pack(
        "<4sIHHIIHH",
        b"fmt ",
        16,
        3,
        1,
        sr,
        sr * 4,
        4,
        32,
    )
    data_chunk = struct.pack("<4sI", b"data", data_size) + pcm
    riff_size = 4 + len(fmt_chunk) + len(data_chunk)
    header = struct.pack("<4sI4s", b"RIFF", riff_size, b"WAVE")
    path.write_bytes(header + fmt_chunk + data_chunk)


def _cqt_sha256(cqt: np.ndarray) -> str:
    """SHA-256 of the CQT matrix as float32 bytes."""
    return hashlib.sha256(cqt.astype(np.float32, copy=False).tobytes()).hexdigest()


def _b64_float32(y: np.ndarray) -> str:
    """Base64-encode a float32 array in little-endian byte order.

    The browser consumes these as ``new Float32Array(decoded_arraybuffer)``;
    little-endian is the JS default on every platform we ship on. Works for
    1-D audio and for 2-D CQT (reshape with the shape also in the manifest).
    """
    return base64.b64encode(y.astype("<f4", copy=False).tobytes()).decode("ascii")


def generate_fixtures(
    out_dir: str | Path,
    clips: tuple[ClipSpec, ...] = CLIP_BANK,
) -> Path:
    """Render every clip, compute its CQT, write all fixture files.

    Writes, per clip:
    - ``<name>.wav``: 32-bit float mono audio at 22 050 Hz.
    - ``<name>.cqt.npy``: ``(n_frames, n_bins)`` float32 CQT matrix.
    - ``<name>.json``: ``{audio_b64, cqt, cqt_sha256}`` ground-truth for the
      browser side (a browser can consume the .json alone; .wav / .npy
      are for Python callers and manual inspection).

    And writes one top-level ``manifest.json`` enumerating every clip's
    sources and hashes.

    Returns the manifest path. Deterministic: two runs on the same input
    produce identical bytes.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    manifest_entries: list[dict[str, Any]] = []
    sr = _LOCAL_PLAN["sample_rate"]

    for spec in clips:
        y = render_clip(spec)
        cqt = compute_cqt(y)

        wav_path = out / f"{spec.name}.wav"
        npy_path = out / f"{spec.name}.cqt.npy"
        json_path = out / f"{spec.name}.json"

        # WAV: PCM_FLOAT (format=3) so we round-trip float32 exactly with
        # no dithering. Use the minimal writer to avoid soundfile's PEAK
        # chunk, which embeds a timestamp and breaks byte-level
        # determinism (the fixture-regen invariant).
        _write_float32_wav(wav_path, y, sr)
        np.save(str(npy_path), cqt, allow_pickle=False)

        audio_hash = _audio_sha256(y)
        cqt_hash = _cqt_sha256(cqt)

        # JSON payload: metadata + CQT ground truth only. Audio stays in the
        # .wav sidecar (WAV float32 PCM, trivial 44-byte header to skip in
        # JS). Keeping audio out of JSON caps fixture-set size at ~4 MB
        # instead of ~9 MB without losing any information.
        json_payload = {
            "name": spec.name,
            "description": spec.description,
            "sample_rate": sr,
            "duration_sec": spec.duration_sec,
            "audio_samples": int(y.shape[0]),
            "audio_path": wav_path.name,
            "audio_sha256": audio_hash,
            "cqt_shape": [int(d) for d in cqt.shape],
            "cqt_b64_float32_le": _b64_float32(cqt),
            "cqt_sha256": cqt_hash,
            "plan": _LOCAL_PLAN,
        }
        json_path.write_text(
            json.dumps(json_payload, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )

        manifest_entries.append(
            {
                "name": spec.name,
                "description": spec.description,
                "kind": spec.kind,
                "duration_sec": spec.duration_sec,
                "audio_path": wav_path.name,
                "cqt_path": npy_path.name,
                "json_path": json_path.name,
                "audio_sha256": audio_hash,
                "cqt_sha256": cqt_hash,
                "cqt_shape": list(cqt.shape),
            }
        )

    manifest = {
        "version": "v1",
        "plan": _LOCAL_PLAN,
        "clip_count": len(clips),
        "clips": manifest_entries,
        "tolerance": {
            "default_max_abs": 1e-3,
            "mobile_max_abs": 1e-2,
            "notes": (
                "PR-Y1.6 (browser) asserts max |librosa_cqt - browser_cqt| < "
                "default_max_abs on desktop WASM/WebGPU. On Adreno 6xx/750 "
                "(Transpose/MatMul defects) the browser falls back to WASM "
                "and relaxes to mobile_max_abs. Any drift above mobile is a "
                "hard fail: do not ship."
            ),
        },
        "source": {
            "module": "training.model.cqt_parity",
            "regenerate_cmd": "python -m training.model.cqt_parity "
            "--out apps/training/tests/fixtures/cqt_parity",
        },
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    return manifest_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Generate librosa↔browser CQT parity fixtures (PR-Y1.5b).",
    )
    parser.add_argument(
        "--out",
        default="apps/training/tests/fixtures/cqt_parity",
        help="Output directory (default: apps/training/tests/fixtures/cqt_parity).",
    )
    args = parser.parse_args(argv)

    manifest_path = generate_fixtures(args.out)
    print(f"Wrote {manifest_path}")
    print(f"  clips={len(CLIP_BANK)}")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(_cli(sys.argv[1:]))


__all__ = [
    "CLIP_BANK",
    "ClipSpec",
    "compute_cqt",
    "generate_fixtures",
    "render_clip",
    "verify_plan_mirror",
]
