"""Tests for the pinned CQT plan (``training.model.cqt_plan``).

The point of pinning the plan in code and in a SHA-hashed JSON manifest is
that the browser-side CQT (shipped in a later PR) can detect drift between
what it was built against and what the trained model actually expects.
These tests lock that contract.

v2 of the plan (PR-Y1.3b) fixes three defects flagged by the alphabet+CQT
red-team brief: global z-norm (→ per_song), missing HPF (→ 70 Hz), and
hop 2048 (→ 1024). Both v1 and v2 code paths are exercised here so the
backward-compat tooling used for A/B comparisons does not silently rot.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from training.model.cqt_plan import (
    PLAN,
    CQTPlan,
    apply_hpf,
    deserialize_plan,
    librosa_cqt,
    plan_sha256,
    read_manifest,
    serialize_plan,
    write_manifest,
)

# ---------------------------------------------------------------------------
# v2 default values + serialization
# ---------------------------------------------------------------------------


def test_cqt_plan_v2_values() -> None:
    """Every pinned field is what the PR-Y1.3b red-team fix says it is.

    This test will fail the moment someone edits ``CQTPlan`` defaults —
    which is on purpose. Any change to the plan is a breaking change for
    the browser-side CQT and MUST be paired with a ``version`` bump and a
    new ``cqt-plan.v<N>.json`` manifest.
    """
    assert PLAN.sample_rate == 22050
    assert PLAN.hop_length == 1024  # v2: was 2048 in v1
    assert PLAN.fmin_hz == pytest.approx(32.70)
    assert PLAN.n_bins == 144
    assert PLAN.bins_per_octave == 24
    assert PLAN.log_amplitude is True
    assert PLAN.z_norm == "per_song"  # v2: was "global" in v1
    assert PLAN.hpf_hz == pytest.approx(70.0)  # v2: NEW
    assert PLAN.version == "v2"


def test_n_bins_is_six_octaves_at_24_bpo() -> None:
    """n_bins must equal bins_per_octave * octaves_covered; 6 × 24 = 144."""
    assert PLAN.n_bins == PLAN.bins_per_octave * 6
    assert PLAN.n_bins % PLAN.bins_per_octave == 0


def test_serialize_deserialize_round_trip() -> None:
    """A plan serialized and then deserialized is equal to the original."""
    data = serialize_plan(PLAN)
    restored = deserialize_plan(data)
    assert restored == PLAN


def test_serialize_contains_every_v2_field() -> None:
    """serialize_plan must include every v2 field — no silent drops."""
    data = serialize_plan(PLAN)
    expected_fields = {
        "sample_rate",
        "hop_length",
        "fmin_hz",
        "n_bins",
        "bins_per_octave",
        "log_amplitude",
        "z_norm",
        "hpf_hz",  # v2 addition
        "version",
    }
    assert set(data.keys()) == expected_fields


def test_deserialize_rejects_unknown_fields() -> None:
    """Unknown fields raise TypeError — schema drift must fail loudly."""
    data = serialize_plan(PLAN)
    data["who_added_this"] = "nobody should"
    with pytest.raises(TypeError):
        deserialize_plan(data)


def test_cqt_plan_v2_serialization_sha_stable() -> None:
    """The v2 plan's sha256 is a function of its canonical JSON — not of time."""
    first = plan_sha256(PLAN)
    second = plan_sha256(PLAN)
    assert first == second
    # And is a hex sha256: 64 chars, all hex.
    assert len(first) == 64
    assert all(c in "0123456789abcdef" for c in first)
    # Locked to the value we wrote into cqt-plan.v2.json. If this changes,
    # the manifest is stale.
    assert first == "2ecedcb2a237081d7758b42bd8068643f67d0d8d892a4625af7a0a4e53758ba0"


def test_plan_sha256_differs_when_a_field_changes() -> None:
    """Any pinned-field change must produce a different sha256."""
    original = plan_sha256(PLAN)
    bumped = plan_sha256(CQTPlan(**{**serialize_plan(PLAN), "hop_length": 2048}))
    assert original != bumped


def test_write_and_read_manifest_round_trip(tmp_path: Path) -> None:
    """write_manifest then read_manifest returns the same plan (v2)."""
    manifest = tmp_path / "cqt-plan.v2.json"
    written = write_manifest(PLAN, manifest)
    assert written == manifest
    assert manifest.exists()

    rehydrated = read_manifest(manifest)
    assert rehydrated == PLAN


def test_read_manifest_detects_tampered_hash(tmp_path: Path) -> None:
    """A manifest whose sha256 doesn't match its plan raises ValueError."""
    manifest = tmp_path / "cqt-plan.v2.json"
    write_manifest(PLAN, manifest)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    # Replace the hash with a plausible-but-wrong one.
    payload["sha256"] = "0" * 64
    manifest.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    with pytest.raises(ValueError, match="sha256 mismatch"):
        read_manifest(manifest)


def test_read_manifest_rejects_missing_fields(tmp_path: Path) -> None:
    """A manifest without 'plan' or 'sha256' raises ValueError."""
    manifest = tmp_path / "cqt-plan.v2.json"
    manifest.write_text(json.dumps({"only": "this"}), encoding="utf-8")
    with pytest.raises(ValueError, match="missing"):
        read_manifest(manifest)


def test_shipped_v2_manifest_matches_current_plan() -> None:
    """The committed ``apps/training/model/cqt-plan.v2.json`` matches PLAN.

    This locks the on-disk manifest to the in-code defaults so a stray edit
    to either one is caught in CI.
    """
    manifest_path = Path(__file__).resolve().parent.parent / "model" / "cqt-plan.v2.json"
    assert manifest_path.exists(), f"missing committed v2 manifest at {manifest_path}"
    rehydrated = read_manifest(manifest_path)
    assert rehydrated == PLAN


# ---------------------------------------------------------------------------
# Backward-compat: v1 manifests still load for A/B comparisons
# ---------------------------------------------------------------------------


def test_cqt_plan_backward_compat_v1_json_loads() -> None:
    """A v1 manifest still loads via read_manifest for A/B comparisons.

    We retain ``cqt-plan.v1.json`` on disk so a v1-trained checkpoint can be
    scored alongside a v2 checkpoint during the migration. The loader must
    accept the v1 payload shape (no ``hpf_hz`` field) and return a plan that
    reproduces v1 behaviour byte-for-byte.
    """
    v1_path = Path(__file__).resolve().parent.parent / "model" / "cqt-plan.v1.json"
    assert v1_path.exists(), "legacy v1 manifest must be retained for A/B"
    v1_plan = read_manifest(v1_path)

    # It is a plan, but NOT the current PLAN.
    assert v1_plan.version == "v1"
    assert v1_plan.hop_length == 2048
    assert v1_plan.z_norm == "global"
    assert v1_plan.hpf_hz == 0.0  # filter was absent in v1
    assert v1_plan != PLAN


def test_cqt_plan_v1_sha_stable_after_v2_bump() -> None:
    """v1's serialized sha256 is byte-stable despite v2 adding a field.

    serialize_plan() strips ``hpf_hz`` from v1 payloads so the on-disk hash
    recorded in ``cqt-plan.v1.json`` keeps verifying after v2 shipped.
    """
    v1_path = Path(__file__).resolve().parent.parent / "model" / "cqt-plan.v1.json"
    recorded_sha = json.loads(v1_path.read_text(encoding="utf-8"))["sha256"]
    assert recorded_sha == "1bb5302dd5f29c6f7551f6fca96b07d15d180c102875e7d25cdde6f53aedf8ed"
    v1_plan = read_manifest(v1_path)
    assert plan_sha256(v1_plan) == recorded_sha


def test_v1_and_v2_manifests_have_distinct_hashes() -> None:
    """v1 and v2 plans must produce different sha256 — both are real artifacts."""
    base = Path(__file__).resolve().parent.parent / "model"
    v1 = read_manifest(base / "cqt-plan.v1.json")
    v2 = read_manifest(base / "cqt-plan.v2.json")
    assert plan_sha256(v1) != plan_sha256(v2)
    assert v1 != v2


# ---------------------------------------------------------------------------
# HPF filter (v2)
# ---------------------------------------------------------------------------


def test_hpf_filter_attenuates_low_frequencies() -> None:
    """A 20 Hz tone through the 70 Hz HPF loses ≥20 dB of amplitude."""
    sr = 22050
    duration_s = 1.0
    t = np.linspace(0.0, duration_s, int(sr * duration_s), endpoint=False, dtype=np.float32)

    # 20 Hz is well below the 70 Hz corner — a 4th-order Butterworth should
    # eat ≥24 dB/oct past the corner, so ~41 dB of attenuation at 20 Hz.
    low = np.sin(2 * np.pi * 20.0 * t).astype(np.float32)
    filtered = apply_hpf(low, PLAN)

    # Use RMS, not peak, because sosfiltfilt startup transients can poke
    # the peak above the steady-state level for a few samples.
    rms_in = float(np.sqrt(np.mean(low**2)))
    rms_out = float(np.sqrt(np.mean(filtered**2)))
    attenuation_db = 20.0 * np.log10(rms_out / rms_in)
    assert attenuation_db < -20.0, f"20 Hz only attenuated by {attenuation_db:.1f} dB"


def test_hpf_filter_passes_mid_frequencies() -> None:
    """A 440 Hz tone through the 70 Hz HPF survives with ≤1 dB loss."""
    sr = 22050
    duration_s = 1.0
    t = np.linspace(0.0, duration_s, int(sr * duration_s), endpoint=False, dtype=np.float32)

    mid = np.sin(2 * np.pi * 440.0 * t).astype(np.float32)
    filtered = apply_hpf(mid, PLAN)

    rms_in = float(np.sqrt(np.mean(mid**2)))
    rms_out = float(np.sqrt(np.mean(filtered**2)))
    attenuation_db = 20.0 * np.log10(rms_out / rms_in)
    assert attenuation_db > -1.0, f"440 Hz lost {-attenuation_db:.2f} dB — HPF too aggressive"


def test_hpf_filter_disabled_when_hpf_hz_zero() -> None:
    """``hpf_hz = 0`` returns the input unchanged (modulo dtype)."""
    sr = 22050
    rng = np.random.default_rng(0)
    y = rng.standard_normal(sr).astype(np.float32) * 0.1

    plan_off = CQTPlan(hpf_hz=0.0, version="v2")
    out = apply_hpf(y, plan_off)
    np.testing.assert_allclose(out, y, atol=1e-7)


# ---------------------------------------------------------------------------
# Per-song z-norm (v2)
# ---------------------------------------------------------------------------


def test_per_song_znorm_normalizes_loudness_gap() -> None:
    """Two songs with a 40 dB loudness gap have similar stddev after per-song z-norm.

    This is the exact failure mode the red team flagged: global z-norm
    would preserve the gap and the quiet track's input would be ~constant;
    per-song z-norm closes it.
    """
    sr = PLAN.sample_rate
    duration_s = 2.0
    t = np.linspace(0.0, duration_s, int(sr * duration_s), endpoint=False, dtype=np.float32)

    # Two C-major-ish chords at very different amplitudes. The content is
    # not musically important; what matters is one is ~100× louder than
    # the other going into the CQT.
    freqs = (261.63, 329.63, 392.00)  # C4, E4, G4
    base = sum(np.sin(2 * np.pi * f * t) for f in freqs).astype(np.float32)
    loud = (base * 0.5).astype(np.float32)
    quiet = (base * 0.005).astype(np.float32)  # ~40 dB below the loud one

    out_loud = librosa_cqt(loud, PLAN)
    out_quiet = librosa_cqt(quiet, PLAN)

    std_loud = float(out_loud.std())
    std_quiet = float(out_quiet.std())
    # After per-song z-norm the two should be within ~15 % of each other.
    assert std_loud == pytest.approx(std_quiet, rel=0.15), (
        f"per-song z-norm failed to close the gap: loud std={std_loud:.3f} "
        f"vs quiet std={std_quiet:.3f}"
    )
    # And each clip's output should have unit-ish stddev — the whole point.
    assert 0.5 < std_loud < 1.5
    assert 0.5 < std_quiet < 1.5


def test_per_track_is_alias_for_per_song() -> None:
    """``per_track`` is the pre-v2 name; v2 keeps it as a silent alias."""
    sr = PLAN.sample_rate
    t = np.linspace(0.0, 1.0, sr, endpoint=False, dtype=np.float32)
    y = np.sin(2 * np.pi * 440.0 * t).astype(np.float32)

    plan_per_song = CQTPlan(z_norm="per_song", version="v2")
    plan_per_track = CQTPlan(z_norm="per_track", version="v2")

    out_a = librosa_cqt(y, plan_per_song)
    out_b = librosa_cqt(y, plan_per_track)
    np.testing.assert_allclose(out_a, out_b, atol=1e-6)


def test_z_norm_none_passes_through() -> None:
    """``z_norm = 'none'`` leaves the CQT un-standardized (diagnostic mode)."""
    sr = PLAN.sample_rate
    t = np.linspace(0.0, 1.0, sr, endpoint=False, dtype=np.float32)
    y = (np.sin(2 * np.pi * 440.0 * t) * 0.5).astype(np.float32)

    plan = CQTPlan(z_norm="none", version="v2")
    out = librosa_cqt(y, plan)
    # log-amplitude outputs tend to sit in the -80..0 dB range; the point
    # of this test is just that no standardization happened, so the mean
    # is nowhere near 0.
    assert abs(float(out.mean())) > 1.0


def test_z_norm_unknown_raises() -> None:
    """An unknown ``z_norm`` value raises ``ValueError`` rather than silent pass-through."""
    sr = PLAN.sample_rate
    t = np.linspace(0.0, 1.0, sr, endpoint=False, dtype=np.float32)
    y = np.sin(2 * np.pi * 440.0 * t).astype(np.float32)

    plan = CQTPlan(z_norm="not-a-mode", version="v2")
    with pytest.raises(ValueError, match="Unknown z_norm"):
        librosa_cqt(y, plan)


# ---------------------------------------------------------------------------
# v1 vs v2 A/B — proves v2 is NOT a no-op
# ---------------------------------------------------------------------------


def test_v1_v2_a_b_produces_different_outputs() -> None:
    """Same audio through v1 and v2 produces measurably different CQTs.

    This is the belt-and-braces check that none of the v2 wiring silently
    collapsed to v1 semantics. If this test ever starts passing on
    ``np.allclose`` of v1 and v2 outputs, something upstream has
    short-circuited the migration.
    """
    sr = PLAN.sample_rate
    duration_s = 2.0
    t = np.linspace(0.0, duration_s, int(sr * duration_s), endpoint=False, dtype=np.float32)
    # A chord with some sub-bass content so the HPF has real work to do,
    # plus the usual C-major triad.
    y = (
        np.sin(2 * np.pi * 30.0 * t) * 0.5  # sub-bass rumble, 30 Hz
        + np.sin(2 * np.pi * 261.63 * t)
        + np.sin(2 * np.pi * 329.63 * t)
        + np.sin(2 * np.pi * 392.00 * t)
    ).astype(np.float32)

    base = Path(__file__).resolve().parent.parent / "model"
    v1 = read_manifest(base / "cqt-plan.v1.json")
    v2 = read_manifest(base / "cqt-plan.v2.json")
    assert v1 != v2

    out_v1 = librosa_cqt(y, v1)
    out_v2 = librosa_cqt(y, v2)

    # Frame counts must differ because the hop halves.
    assert out_v2.shape[0] > out_v1.shape[0]
    # Bin count is unchanged.
    assert out_v1.shape[1] == out_v2.shape[1] == v1.n_bins == v2.n_bins

    # The two low-level pipelines are not the same transform, so the
    # outputs must not coincidentally match even on overlapping frames.
    # Compare the mean per-bin profile (bin-wise average over frames),
    # which has the same length for both.
    profile_v1 = out_v1.mean(axis=0)
    profile_v2 = out_v2.mean(axis=0)
    assert not np.allclose(
        profile_v1, profile_v2, atol=1e-2
    ), "v1 and v2 produced near-identical bin-mean profiles — migration may be a no-op"
