"""Tests for the pinned CQT plan (``training.model.cqt_plan``).

The point of pinning the plan in code and in a SHA-hashed JSON manifest is
that the browser-side CQT (shipped in a later PR) can detect drift between
what it was built against and what the trained model actually expects.
These tests lock that contract.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from training.model.cqt_plan import (
    PLAN,
    CQTPlan,
    deserialize_plan,
    plan_sha256,
    read_manifest,
    serialize_plan,
    write_manifest,
)


def test_plan_default_values_pinned() -> None:
    """Every pinned field is what the Y1 decision record says it is.

    This test will fail the moment someone edits ``CQTPlan`` defaults — which
    is on purpose. Any change to the plan is a breaking change for the
    browser-side CQT and MUST be paired with a ``version`` bump and a new
    ``cqt-plan.v<N>.json`` manifest.
    """
    assert PLAN.sample_rate == 22050
    assert PLAN.hop_length == 2048
    assert PLAN.fmin_hz == pytest.approx(32.70)
    assert PLAN.n_bins == 144
    assert PLAN.bins_per_octave == 24
    assert PLAN.log_amplitude is True
    assert PLAN.z_norm == "global"
    assert PLAN.version == "v1"


def test_n_bins_is_six_octaves_at_24_bpo() -> None:
    """n_bins must equal bins_per_octave * octaves_covered; 6 × 24 = 144."""
    assert PLAN.n_bins == PLAN.bins_per_octave * 6
    assert PLAN.n_bins % PLAN.bins_per_octave == 0


def test_serialize_deserialize_round_trip() -> None:
    """A plan serialized and then deserialized is equal to the original."""
    data = serialize_plan(PLAN)
    restored = deserialize_plan(data)
    assert restored == PLAN


def test_serialize_contains_every_field() -> None:
    """serialize_plan must include every field — no silent drops."""
    data = serialize_plan(PLAN)
    expected_fields = {
        "sample_rate",
        "hop_length",
        "fmin_hz",
        "n_bins",
        "bins_per_octave",
        "log_amplitude",
        "z_norm",
        "version",
    }
    assert set(data.keys()) == expected_fields


def test_deserialize_rejects_unknown_fields() -> None:
    """Unknown fields raise TypeError — schema drift must fail loudly."""
    data = serialize_plan(PLAN)
    data["who_added_this"] = "nobody should"
    with pytest.raises(TypeError):
        deserialize_plan(data)


def test_plan_sha256_stable_across_runs() -> None:
    """The plan's sha256 is a function of its canonical JSON — not of time."""
    first = plan_sha256(PLAN)
    second = plan_sha256(PLAN)
    assert first == second
    # And is a hex sha256: 64 chars, all hex.
    assert len(first) == 64
    assert all(c in "0123456789abcdef" for c in first)


def test_plan_sha256_differs_when_a_field_changes() -> None:
    """Any pinned-field change must produce a different sha256."""
    original = plan_sha256(PLAN)
    bumped = plan_sha256(CQTPlan(**{**serialize_plan(PLAN), "hop_length": 1024}))
    assert original != bumped


def test_write_and_read_manifest_round_trip(tmp_path: Path) -> None:
    """write_manifest then read_manifest returns the same plan."""
    manifest = tmp_path / "cqt-plan.v1.json"
    written = write_manifest(PLAN, manifest)
    assert written == manifest
    assert manifest.exists()

    rehydrated = read_manifest(manifest)
    assert rehydrated == PLAN


def test_read_manifest_detects_tampered_hash(tmp_path: Path) -> None:
    """A manifest whose sha256 doesn't match its plan raises ValueError."""
    manifest = tmp_path / "cqt-plan.v1.json"
    write_manifest(PLAN, manifest)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    # Replace the hash with a plausible-but-wrong one.
    payload["sha256"] = "0" * 64
    manifest.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    with pytest.raises(ValueError, match="sha256 mismatch"):
        read_manifest(manifest)


def test_read_manifest_rejects_missing_fields(tmp_path: Path) -> None:
    """A manifest without 'plan' or 'sha256' raises ValueError."""
    manifest = tmp_path / "cqt-plan.v1.json"
    manifest.write_text(json.dumps({"only": "this"}), encoding="utf-8")
    with pytest.raises(ValueError, match="missing"):
        read_manifest(manifest)


def test_shipped_manifest_matches_current_plan() -> None:
    """The committed ``apps/training/model/cqt-plan.v1.json`` matches PLAN.

    This locks the on-disk manifest to the in-code defaults so a stray edit
    to either one is caught in CI.
    """
    manifest_path = Path(__file__).resolve().parent.parent / "model" / "cqt-plan.v1.json"
    assert manifest_path.exists(), f"missing committed manifest at {manifest_path}"
    rehydrated = read_manifest(manifest_path)
    assert rehydrated == PLAN
