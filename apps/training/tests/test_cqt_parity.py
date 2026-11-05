"""Tests for ``training.model.cqt_parity`` (PR-Y1.5b).

This test suite works on a fresh checkout off ``v3/main`` — no PR-Y1.3 /
PR-Y1.4 imports are required. The parity module is self-contained (local
plan mirror) and the only runtime deps are ``librosa``, ``numpy``, and
``soundfile``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("librosa")
pytest.importorskip("soundfile")

# ruff: noqa: E402 — importorskip must come before the real imports.
from training.model.cqt_parity import (  # noqa: E402
    _LOCAL_PLAN,
    CLIP_BANK,
    ClipSpec,
    compute_cqt,
    generate_fixtures,
    render_clip,
    verify_plan_mirror,
)
from training.model.cqt_plan import PLAN, apply_hpf  # noqa: E402

# ---------------------------------------------------------------------------
# Spec invariants
# ---------------------------------------------------------------------------


def test_clip_bank_has_twenty_clips() -> None:
    """Decision record calls for a 20-clip bank. Enforce it."""
    assert len(CLIP_BANK) == 20, f"expected 20 clips, got {len(CLIP_BANK)}"


def test_clip_names_are_unique() -> None:
    """Every clip must have a unique on-disk filename stem."""
    names = [c.name for c in CLIP_BANK]
    assert len(names) == len(set(names)), f"duplicate clip names: {names}"


def test_clip_kinds_are_known() -> None:
    """Every clip spec must declare a renderer we implement."""
    known = {"sine", "sine_chord", "white_noise", "pink_noise", "sweep", "silence", "mixed"}
    for c in CLIP_BANK:
        assert c.kind in known, f"unknown kind {c.kind!r} for clip {c.name}"


def test_local_plan_mirror_against_pr_y1_3_when_available() -> None:
    """When PR-Y1.3 is on this branch the mirror must match byte-for-byte.

    verify_plan_mirror() is a silent no-op when PR-Y1.3 isn't importable, so
    on a fresh v3/main checkout this test effectively asserts "the mirror
    is self-consistent". When PR-Y1.3 merges in, the same test asserts
    the real invariant.
    """
    verify_plan_mirror()  # does nothing on fresh v3/main; raises on drift.
    # Independent-of-PR-Y1.3 sanity checks:
    assert _LOCAL_PLAN["n_bins"] == 144
    assert _LOCAL_PLAN["bins_per_octave"] == 24
    assert _LOCAL_PLAN["sample_rate"] == 22050


# ---------------------------------------------------------------------------
# Deterministic rendering
# ---------------------------------------------------------------------------


def test_render_clip_is_deterministic_for_noise() -> None:
    """Seeded noise clips render identically across calls."""
    spec = ClipSpec("test_noise", "deterministic noise", 0.5, "white_noise", seed=1234)
    a = render_clip(spec)
    b = render_clip(spec)
    assert np.array_equal(a, b), "same spec produced different bytes"


def test_render_clip_silence_is_all_zero() -> None:
    """Silence clips are literal zeros, not subnormals."""
    spec = ClipSpec("test_silence", "silence", 0.3, "silence")
    y = render_clip(spec)
    assert y.shape == (int(0.3 * _LOCAL_PLAN["sample_rate"]),)
    assert np.max(np.abs(y)) == 0.0


def test_render_clip_sine_respects_amplitude() -> None:
    """Pure sines come out below their amplitude ceiling."""
    spec = ClipSpec("test_sine", "440 Hz", 1.0, "sine", (440.0,), amplitude=0.25)
    y = render_clip(spec)
    # Peak should be at or just under the amplitude (sampling may undershoot).
    assert np.max(np.abs(y)) <= 0.25 + 1e-6
    assert np.max(np.abs(y)) >= 0.24


def test_render_clip_dtype_is_float32() -> None:
    """Everything returns float32 — WAV + CQT depend on it."""
    for kind, args in [
        ("sine", (440.0,)),
        ("sine_chord", (261.63, 329.63, 392.00)),
        ("white_noise", ()),
        ("pink_noise", ()),
        ("sweep", (55.0, 880.0)),
        ("silence", ()),
        ("mixed", (440.0,)),
    ]:
        y = render_clip(ClipSpec(f"t_{kind}", "t", 0.2, kind, args, amplitude=0.3, seed=0))
        assert y.dtype == np.float32, f"{kind} returned {y.dtype}, expected float32"


# ---------------------------------------------------------------------------
# CQT invariants
# ---------------------------------------------------------------------------


def test_compute_cqt_returns_frame_major_144_bins() -> None:
    """CQT comes back shape (n_frames, 144), float32."""
    spec = CLIP_BANK[2]  # sine_a4_440hz
    y = render_clip(spec)
    cqt = compute_cqt(y)
    assert cqt.ndim == 2
    assert cqt.shape[1] == 144
    assert cqt.dtype == np.float32


def test_compute_cqt_is_deterministic() -> None:
    """Same audio → bit-identical CQT bytes across calls."""
    y = render_clip(CLIP_BANK[8])  # chord_c_major_root
    cqt_a = compute_cqt(y)
    cqt_b = compute_cqt(y)
    assert np.array_equal(cqt_a, cqt_b), "CQT output drifted across calls"


# ---------------------------------------------------------------------------
# Fixture regeneration — SHA stability
# ---------------------------------------------------------------------------


def test_generate_fixtures_is_deterministic(tmp_path: Path) -> None:
    """Running the fixture generator twice yields byte-identical files.

    This is the invariant the browser side relies on: any time the Python
    side regenerates the fixtures, every file must be byte-identical so
    PR-Y1.6 can assert parity against a pinned hash, and so git diffs stay
    noise-free. The custom float32 WAV writer (see
    ``cqt_parity._write_float32_wav``) deliberately omits soundfile's
    PEAK chunk, which otherwise embeds a wall-clock timestamp.
    """
    out_a = tmp_path / "run_a"
    out_b = tmp_path / "run_b"
    manifest_a = generate_fixtures(out_a)
    manifest_b = generate_fixtures(out_b)

    # Manifest is JSON-identical (every audio_sha256 / cqt_sha256 is
    # position-pinned and deterministic).
    assert manifest_a.read_bytes() == manifest_b.read_bytes()

    # Every emitted sidecar — .wav, .cqt.npy, .json — must match byte for
    # byte across runs.
    data_a = json.loads(manifest_a.read_text())
    for clip in data_a["clips"]:
        for key in ("audio_path", "cqt_path", "json_path"):
            fa = out_a / clip[key]
            fb = out_b / clip[key]
            assert (
                fa.read_bytes() == fb.read_bytes()
            ), f"nondeterministic: {clip['name']}/{key} differs between runs"


# ─────────────────────────────────────────────────────────────────────────────
# HPF-starved clips: why a few fixtures cannot be SHA-compared
# ─────────────────────────────────────────────────────────────────────────────
#
# Plan v2 applies a 70 Hz zero-phase high-pass BEFORE the CQT (matching
# ChordFormer; sub-bass carries little chord information). But the CQT's own
# fmin is 32.70 Hz, so bins 0..26 of 144 (18.8%) sit BELOW the filter corner
# by design.
#
# A fixture that is pure tone below that corner is therefore reduced to the
# filter's residual. Measured on `sine_c1_32_70hz` (a 32.70 Hz sine, exactly
# fmin): RMS 0.212 -> 9.6e-4, a 220x attenuation. The control at 440 Hz is
# attenuated 1.000x.
#
# The CQT of that residual sits near the amplitude floor (AMIN = 1e-5), where
# per-bin log clamping and last-bit float rounding dominate the output. Those
# bits differ between numpy/scipy builds, BLAS kernels and CPU instruction
# sets — so a byte-exact SHA is NOT reproducible across machines. Observed
# directly: this clip's SHA matched locally and differed on the GitHub runner,
# on identical code.
#
# This is a property of the fixture, not a defect in the plan or generator.
# Rather than hardcode a clip name (which would silently go stale if hpf_hz
# changes), classification is computed from the audio: any clip the plan's own
# filter attenuates by more than _HPF_STARVE_RATIO is compared numerically.
# Change hpf_hz and the set reclassifies itself.

_HPF_STARVE_RATIO = 20.0  # >20x RMS attenuation => output is filter residual
_HPF_STARVED_TOL = 1e-6  # a real generator change moves values far more


def _read_wav_f32(path: Path) -> np.ndarray:
    """Read a mono float32 WAV. stdlib `wave` cannot read format=3 (float)."""
    b = path.read_bytes()
    n_bytes = struct.unpack("<I", b[40:44])[0]
    return np.frombuffer(b[44 : 44 + n_bytes], dtype="<f4")


def _is_hpf_starved(root: Path, entry: dict) -> bool:
    """True if the plan's HPF removes most of this clip's energy.

    Such a clip's CQT is the filter's residual, near the AMIN floor, and is
    not bit-reproducible across machines — so the caller compares it
    numerically instead of by SHA.
    """
    if PLAN.hpf_hz <= 0:
        return False
    audio = root / entry["audio_path"]
    if not audio.exists():
        return False
    x = _read_wav_f32(audio).astype(np.float64)
    if x.size == 0:
        return False
    rms_before = float(np.sqrt(np.mean(x**2)))
    if rms_before <= 0.0:
        return False  # silence is exactly zero and reproduces fine
    y = apply_hpf(x, PLAN)
    rms_after = float(np.sqrt(np.mean(np.asarray(y, dtype=np.float64) ** 2)))
    if rms_after <= 0.0:
        return True
    return (rms_before / rms_after) > _HPF_STARVE_RATIO


def _load_cqt(root: Path, entry: dict) -> np.ndarray:
    """Load a fixture's CQT as a 2-D array, from the .npy beside the manifest."""
    return np.load(root / entry["cqt_path"]).reshape(tuple(entry["cqt_shape"]))


def test_committed_fixtures_match_current_sha(tmp_path: Path) -> None:
    """The fixtures committed to the repo must match what the generator emits now.

    This is the regression gate: if anyone bumps the plan mirror, tweaks a
    renderer, or changes the librosa call, the committed fixture SHAs must
    also change. Catches silent drift.
    """
    committed_root = Path(__file__).parent / "fixtures" / "cqt_parity"
    committed_manifest = committed_root / "manifest.json"
    if not committed_manifest.exists():
        pytest.skip("committed fixtures not present (expected: PR not yet landed)")

    manifest = json.loads(committed_manifest.read_text())

    # Regenerate into tmp_path.
    live_manifest_path = generate_fixtures(tmp_path)
    live_manifest = json.loads(live_manifest_path.read_text())
    assert live_manifest["clip_count"] == manifest["clip_count"]

    committed_by_name = {c["name"]: c for c in manifest["clips"]}
    live_by_name = {c["name"]: c for c in live_manifest["clips"]}

    for name, live_entry in live_by_name.items():
        assert name in committed_by_name, f"regenerated clip {name} not in committed manifest"
        committed_entry = committed_by_name[name]

        if _is_hpf_starved(committed_root, committed_entry):
            # SHA equality is not achievable for this clip across machines.
            # See _is_hpf_starved for why. Assert numeric equivalence at a
            # tight tolerance instead — this still catches a real generator
            # change (which moves values by far more than 1e-6) while
            # tolerating last-bit float differences between BLAS builds.
            live_cqt = _load_cqt(tmp_path, live_entry)
            committed_cqt = _load_cqt(committed_root, committed_entry)
            assert live_cqt.shape == committed_cqt.shape, (
                f"CQT shape drift on {name}: "
                f"committed={committed_cqt.shape} regenerated={live_cqt.shape}"
            )
            max_abs = float(np.max(np.abs(live_cqt - committed_cqt)))
            assert max_abs < _HPF_STARVED_TOL, (
                f"CQT drift on {name} (HPF-starved clip, compared numerically "
                f"rather than by SHA): max abs diff {max_abs:.3e} exceeds "
                f"{_HPF_STARVED_TOL:.0e}. A diff this large is a real generator "
                f"change, not float noise."
            )
        else:
            assert live_entry["cqt_sha256"] == committed_entry["cqt_sha256"], (
                f"CQT SHA drift on {name}: "
                f"committed={committed_entry['cqt_sha256']} "
                f"regenerated={live_entry['cqt_sha256']}"
            )
        assert live_entry["audio_sha256"] == committed_entry["audio_sha256"], (
            f"audio SHA drift on {name}: "
            f"committed={committed_entry['audio_sha256']} "
            f"regenerated={live_entry['audio_sha256']}"
        )


def test_fixture_json_contains_cqt_base64(tmp_path: Path) -> None:
    """The JSON a browser will fetch has a base64-encoded CQT that matches the npy."""
    generate_fixtures(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    clip = manifest["clips"][0]

    npy = np.load(tmp_path / clip["cqt_path"])
    payload = json.loads((tmp_path / clip["json_path"]).read_text())
    decoded = np.frombuffer(base64.b64decode(payload["cqt_b64_float32_le"]), dtype="<f4").reshape(
        payload["cqt_shape"]
    )
    assert npy.shape == decoded.shape
    assert np.array_equal(npy, decoded)


def test_manifest_lists_exactly_twenty_clips(tmp_path: Path) -> None:
    """generate_fixtures writes a manifest with 20 clip entries."""
    generate_fixtures(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["clip_count"] == 20
    assert len(manifest["clips"]) == 20


def test_manifest_records_default_and_mobile_tolerances(tmp_path: Path) -> None:
    """Tolerance documentation must be present for PR-Y1.6 to pick up."""
    generate_fixtures(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    tol = manifest["tolerance"]
    assert tol["default_max_abs"] == 1e-3
    assert tol["mobile_max_abs"] == 1e-2
    assert "adreno" in tol["notes"].lower()


def test_cqt_sha_in_manifest_matches_cqt_file(tmp_path: Path) -> None:
    """Every manifest entry's cqt_sha256 matches the npy bytes."""
    generate_fixtures(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    for clip in manifest["clips"]:
        arr = np.load(tmp_path / clip["cqt_path"])
        expected = hashlib.sha256(arr.astype(np.float32, copy=False).tobytes()).hexdigest()
        assert clip["cqt_sha256"] == expected, f"sha mismatch for {clip['name']}"
