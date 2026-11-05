"""ChordNet 2E1D wiring tests — forward shape, grad flow, parameter budget.

These tests cover the output contract of ``ChordNet2E1D`` (see
``apps/training/model/chordnet_2e1d.py``) as the training code consumes it:
three modes (``factored`` default, ``structured``, ``flat170``), each with its
own head keys and shapes. The factored mode emits ``root_logits`` /
``quality_logits`` / ``bass_logits``; the old two-head ``quality`` / ``bass``
dict was a regression and is gone.
"""

from __future__ import annotations

import pytest
import torch

from training.model.alphabet import NUM_ROOTS
from training.model.chordnet_2e1d import (
    CQT_N_BINS,
    N_BASS,
    N_QUALITY,
    ChordNet2E1D,
)


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_construct_default_hyperparams() -> None:
    model = ChordNet2E1D()
    assert isinstance(model, torch.nn.Module)
    assert model.n_bins == CQT_N_BINS
    assert model.d_model == 256


@pytest.mark.parametrize(
    "bad_kwargs",
    [
        {"n_bins": 0},
        {"d_model": 0},
        {"gru_layers": 0},
    ],
)
def test_construct_rejects_invalid_hyperparams(bad_kwargs: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        ChordNet2E1D(**bad_kwargs)


# ---------------------------------------------------------------------------
# Forward shape — the primary contract the training loop depends on.
# ---------------------------------------------------------------------------


def test_forward_returns_factored_heads_shape() -> None:
    model = ChordNet2E1D()
    assert model.output_mode == "factored"  # default mode
    x = torch.randn(4, 32, CQT_N_BINS)
    out = model(x)
    assert set(out.keys()) == {"root_logits", "quality_logits", "bass_logits"}
    assert out["root_logits"].shape == (4, 32, NUM_ROOTS + 1)
    assert out["quality_logits"].shape == (4, 32, N_QUALITY)
    assert out["bass_logits"].shape == (4, 32, N_BASS)


def test_forward_structured_heads_shape() -> None:
    model = ChordNet2E1D(output_mode="structured")
    out = model(torch.randn(4, 32, CQT_N_BINS))
    assert set(out.keys()) == {"root", "triad", "bass_interval", "has_7th"}
    assert out["root"].shape == (4, 32, NUM_ROOTS + 1)
    assert out["triad"].shape == (4, 32, 5)
    assert out["bass_interval"].shape == (4, 32, 13)
    assert out["has_7th"].shape == (4, 32, 4)


def test_forward_flat170_heads_shape() -> None:
    model = ChordNet2E1D(output_mode="flat170")
    out = model(torch.randn(4, 32, CQT_N_BINS))
    assert set(out.keys()) == {"flat170"}
    assert out["flat170"].shape == (4, 32, 170)


def test_legacy_two_head_keys_are_gone() -> None:
    """Guard against re-introducing the PR #98 ``quality`` / ``bass`` dict."""
    out = ChordNet2E1D()(torch.randn(1, 8, CQT_N_BINS))
    assert "quality" not in out
    assert "bass" not in out


def test_forward_wrong_n_bins_raises() -> None:
    model = ChordNet2E1D(n_bins=CQT_N_BINS)
    bad = torch.randn(2, 16, CQT_N_BINS + 1)
    with pytest.raises(ValueError, match="input last dim must be"):
        model(bad)


def test_forward_wrong_ndim_raises() -> None:
    model = ChordNet2E1D()
    bad = torch.randn(32, CQT_N_BINS)  # 2D, missing batch
    with pytest.raises(ValueError, match="3D"):
        model(bad)


# ---------------------------------------------------------------------------
# Grad flow — every parameter should receive a non-zero grad on random data.
# ---------------------------------------------------------------------------


def test_grad_flow_reaches_every_parameter() -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D()
    x = torch.randn(2, 16, CQT_N_BINS)
    out = model(x)
    loss = (
        out["root_logits"].float().sum()
        + out["quality_logits"].float().sum()
        + out["bass_logits"].float().sum()
    )
    loss.backward()
    for name, p in model.named_parameters():
        assert p.grad is not None, f"{name} has no grad"
        assert torch.isfinite(p.grad).all(), f"{name} grad non-finite"


# ---------------------------------------------------------------------------
# Parameter budget — must land inside the ~2-3M target so the model fits on
# an L4 and exports cleanly to ONNX.
# ---------------------------------------------------------------------------


def test_param_count_within_l4_budget() -> None:
    model = ChordNet2E1D()
    n_params = sum(p.numel() for p in model.parameters())
    assert 500_000 < n_params < 10_000_000, f"param count {n_params} outside [0.5M, 10M]"
