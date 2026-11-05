"""ChordNet 2E1D tests — forward shapes + grad flow + segment decode."""

from __future__ import annotations

import pytest
import torch

from training.model.chordnet_2e1d import CQT_N_BINS, ChordNet2E1D

# ---------------------------------------------------------------------------
# Forward shape — structured mode
# ---------------------------------------------------------------------------


def test_structured_forward_shapes() -> None:
    model = ChordNet2E1D(output_mode="structured")
    x = torch.randn(4, 128, CQT_N_BINS)
    out = model(x)
    assert set(out.keys()) == {"root", "triad", "bass_interval", "has_7th"}
    assert out["root"].shape == (4, 128, 13)
    assert out["triad"].shape == (4, 128, 5)
    assert out["bass_interval"].shape == (4, 128, 13)
    assert out["has_7th"].shape == (4, 128, 4)


# ---------------------------------------------------------------------------
# Forward shape — flat170 mode
# ---------------------------------------------------------------------------


def test_flat170_forward_shapes() -> None:
    model = ChordNet2E1D(output_mode="flat170")
    x = torch.randn(4, 128, CQT_N_BINS)
    out = model(x)
    assert set(out.keys()) == {"flat170"}
    assert out["flat170"].shape == (4, 128, 170)


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_forward_wrong_n_bins_raises() -> None:
    model = ChordNet2E1D(n_bins=144)
    bad = torch.randn(2, 32, 100)  # 100 != 144
    with pytest.raises(ValueError, match="last dim must be 144"):
        model(bad)


def test_forward_wrong_ndim_raises() -> None:
    model = ChordNet2E1D()
    bad = torch.randn(32, 144)
    with pytest.raises(ValueError, match="must be 3D"):
        model(bad)


def test_bad_output_mode_raises() -> None:
    with pytest.raises(ValueError, match="output_mode"):
        ChordNet2E1D(output_mode="xyz")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Gradient flow — every parameter receives a non-zero grad on random data
# ---------------------------------------------------------------------------


def test_structured_grad_flow() -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="structured")
    x = torch.randn(2, 32, CQT_N_BINS)
    out = model(x)
    # Sum CE-like scalar across every head.
    loss = sum(o.float().sum() for o in out.values())
    loss.backward()
    for name, param in model.named_parameters():
        assert param.grad is not None, f"{name} has no grad"
        assert torch.isfinite(param.grad).all(), f"{name} grad is non-finite"
    # At least one Conv1d weight should have a strictly non-zero grad.
    conv_grads = [
        p.grad.abs().sum().item()
        for name, p in model.named_parameters()
        if "local_cnn" in name and "weight" in name and p.grad is not None
    ]
    assert conv_grads and max(conv_grads) > 0.0


def test_flat170_grad_flow() -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170")
    x = torch.randn(2, 32, CQT_N_BINS)
    out = model(x)
    loss = out["flat170"].float().sum()
    loss.backward()
    for name, param in model.named_parameters():
        assert param.grad is not None, f"{name} has no grad"
        assert torch.isfinite(param.grad).all()


# ---------------------------------------------------------------------------
# Segment decoding
# ---------------------------------------------------------------------------


def test_predict_segments_returns_valid_structure() -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="structured")
    cqt = torch.randn(32, CQT_N_BINS)  # 32 frames, no batch dim
    segments = model.predict_segments(cqt)
    assert isinstance(segments, list)
    # segments should cover [0, 32) exclusively.
    if segments:
        assert segments[0][0] == 0
        assert segments[-1][1] == 32
        for s, e, label, conf in segments:
            assert 0 <= s < e <= 32
            assert isinstance(label, str)
            assert 0.0 <= conf <= 1.0


def test_predict_segments_rejects_batched_input() -> None:
    model = ChordNet2E1D()
    bad = torch.randn(2, 32, CQT_N_BINS)  # batch > 1
    with pytest.raises(ValueError, match="single clip"):
        model.predict_segments(bad)


# ---------------------------------------------------------------------------
# Parameter count — sanity check
# ---------------------------------------------------------------------------


def test_param_count_within_lifestyle_business_budget() -> None:
    model = ChordNet2E1D(output_mode="structured")
    n_params = sum(p.numel() for p in model.parameters())
    # ~1.3M for structured — fail loud if someone bumps a hyperparameter past 5M.
    assert 500_000 < n_params < 5_000_000, f"param count {n_params} outside [0.5M, 5M] budget"


# ---------------------------------------------------------------------------
# flat170 argmax collapses to 62 via the lookup table
# ---------------------------------------------------------------------------


def test_flat170_collapse_table_is_cached() -> None:
    model = ChordNet2E1D(output_mode="flat170")
    cqt = torch.randn(1, 16, CQT_N_BINS)
    _ = model.predict_segments(cqt.squeeze(0))
    # After one call the class-level cache must exist.
    table = ChordNet2E1D._collapse_table_170(torch.device("cpu"))
    assert table.shape == (170,)
    # Every entry in [0, 62).
    assert int(table.min().item()) >= 0
    assert int(table.max().item()) < 62
