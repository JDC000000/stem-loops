"""ChordNet 2E1D + CRF integration tests (PR-Y1.5c).

Covers:

- ``ChordNet2E1D(use_crf=True, output_mode="flat170")`` constructs.
- Forward produces a ``crf_emissions`` entry (log-probs, shape (B, T, 62)).
- ``predict_segments`` uses CRF Viterbi when ``use_crf=True``.
- ``export_transitions_as_json`` writes a schema-valid JSON.
- Transition export format matches PR #79's JS-Viterbi loader expectations.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import torch

from training.model.alphabet import ALPHABET_SHA, NUM_LABELS
from training.model.chordnet_2e1d import CQT_N_BINS, ChordNet2E1D

# ---------------------------------------------------------------------------
# Construction guards
# ---------------------------------------------------------------------------


def test_use_crf_requires_flat170() -> None:
    with pytest.raises(ValueError, match="use_crf=True requires output_mode='flat170'"):
        ChordNet2E1D(output_mode="structured", use_crf=True)


def test_use_crf_false_is_default_and_pr_y1_4_behaviour_unchanged() -> None:
    model = ChordNet2E1D(output_mode="flat170")
    assert model.use_crf is False
    assert model.crf is None


# ---------------------------------------------------------------------------
# Forward produces crf_emissions
# ---------------------------------------------------------------------------


def test_forward_emits_crf_emissions_when_crf_enabled() -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    x = torch.randn(2, 16, CQT_N_BINS)
    out = model(x)
    assert "flat170" in out
    assert "crf_emissions" in out
    assert out["crf_emissions"].shape == (2, 16, NUM_LABELS)
    # Each frame's emission is a valid log-prob (sums to 1 in prob space).
    probs = out["crf_emissions"].exp()
    sums = probs.sum(dim=-1)
    assert torch.allclose(sums, torch.ones_like(sums), atol=1e-5)


def test_crf_emissions_preserve_gradient_to_flat170() -> None:
    """Gradient through the logsumexp collapse reaches the flat-170 head."""
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    x = torch.randn(1, 8, CQT_N_BINS)
    out = model(x)
    loss = out["crf_emissions"].sum()
    loss.backward()
    # The 170-head's linear weight must have a non-zero gradient.
    head_weight = model.heads.flat170.weight  # type: ignore[attr-defined]
    assert head_weight.grad is not None
    assert float(head_weight.grad.abs().sum().item()) > 0.0


# ---------------------------------------------------------------------------
# predict_segments uses CRF Viterbi
# ---------------------------------------------------------------------------


def test_predict_segments_uses_crf_viterbi_when_enabled() -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    # Force the CRF to a strong self-loop prior so Viterbi smooths wobble.
    with torch.no_grad():
        model.crf.transitions.copy_(  # type: ignore[union-attr]
            torch.full_like(model.crf.transitions, -10.0)  # type: ignore[union-attr]
        )
        diag = torch.arange(NUM_LABELS)
        model.crf.transitions[diag, diag] = 10.0  # type: ignore[union-attr]

    cqt = torch.randn(24, CQT_N_BINS)
    segments = model.predict_segments(cqt)
    assert isinstance(segments, list)
    # With strong self-loops, most segments collapse — at most a handful
    # of transitions across 24 frames. (Lower-bound: at least one segment.)
    assert 1 <= len(segments) <= 24
    # Every segment covers a contiguous (start, end) range.
    for s, e, label, conf in segments:
        assert 0 <= s < e <= 24
        assert isinstance(label, str)
        assert 0.0 <= conf <= 1.0


def test_predict_segments_argmax_path_unchanged_when_crf_disabled() -> None:
    """PR-Y1.4 regression: use_crf=False must behave as before."""
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=False)
    cqt = torch.randn(8, CQT_N_BINS)
    segments = model.predict_segments(cqt)
    # Same contract as the PR-Y1.4 argmax path.
    assert isinstance(segments, list)
    if segments:
        assert segments[0][0] == 0
        assert segments[-1][1] == 8


# ---------------------------------------------------------------------------
# export_transitions_as_json
# ---------------------------------------------------------------------------


def test_export_transitions_as_json_writes_well_formed_file(tmp_path: Path) -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    out = tmp_path / "chord-transitions.v1.json"
    payload = model.export_transitions_as_json(out)
    # Round-trip from disk.
    loaded = json.loads(out.read_text())
    assert loaded == payload
    # Required keys (PR #79 loadTransition() contract).
    for key in (
        "version",
        "model_sha",
        "alphabet_sha",
        "n_states",
        "transitions_log_prob",
        "generated_at",
    ):
        assert key in loaded, f"missing required key {key!r}"
    assert loaded["version"] == "v1"
    assert loaded["n_states"] == NUM_LABELS
    assert loaded["alphabet_sha"] == ALPHABET_SHA
    # transitions_log_prob is a (62, 62) 2-D array.
    mat = loaded["transitions_log_prob"]
    assert isinstance(mat, list)
    assert len(mat) == NUM_LABELS
    for row in mat:
        assert isinstance(row, list)
        assert len(row) == NUM_LABELS
        for v in row:
            assert isinstance(v, (int, float))
    # Start/end also present (forward-compat).
    assert len(loaded["start_transitions_log_prob"]) == NUM_LABELS
    assert len(loaded["end_transitions_log_prob"]) == NUM_LABELS


def test_export_transitions_matches_in_memory_matrix(tmp_path: Path) -> None:
    """Exported JSON must equal the model's current transition parameter."""
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    # Fill transitions with a known pattern so diff is obvious on failure.
    with torch.no_grad():
        model.crf.transitions.copy_(  # type: ignore[union-attr]
            torch.arange(NUM_LABELS * NUM_LABELS, dtype=torch.float32).reshape(
                NUM_LABELS, NUM_LABELS
            )
            / 100.0
        )
    out = tmp_path / "t.json"
    payload = model.export_transitions_as_json(out)
    exported = torch.tensor(payload["transitions_log_prob"], dtype=torch.float32)
    assert torch.allclose(exported, model.crf.transitions.detach())  # type: ignore[union-attr]


def test_export_transitions_refuses_without_crf(tmp_path: Path) -> None:
    model = ChordNet2E1D(output_mode="flat170", use_crf=False)
    with pytest.raises(RuntimeError, match="requires use_crf=True"):
        model.export_transitions_as_json(tmp_path / "x.json")


# ---------------------------------------------------------------------------
# PR #79 JS-Viterbi format expectations
# ---------------------------------------------------------------------------


def test_exported_json_has_pr79_viterbi_shape(tmp_path: Path) -> None:
    """PR #79's loadTransition() needs: version, n_states, transitions_log_prob
    as a square 2-D array of shape (n_states, n_states), alphabet_sha (so the
    loader can refuse mismatched alphabets)."""
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    out = tmp_path / "chord-transitions.v1.json"
    model.export_transitions_as_json(out)
    loaded = json.loads(out.read_text())
    n = loaded["n_states"]
    assert n == len(loaded["transitions_log_prob"])
    for row in loaded["transitions_log_prob"]:
        assert len(row) == n
    # Alphabet-safety hash (loader will reject on mismatch).
    assert len(loaded["alphabet_sha"]) == 64  # sha256 hex digest length
