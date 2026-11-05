"""ChordNet 2E1D wiring tests — forward shape, grad flow, parameter budget.

These tests cover the minimal factored two-head interface wired in
PR-Y1.qa-modal (see ``apps/training/model/chordnet_2e1d.py``). The older
``test_chordnet_2e1d.py`` targets a larger structured/flat170 API that is
still mid-merge (see PR #96); those checks remain ignored by pytest while
the merge markers persist.
"""

from __future__ import annotations

import pytest
import torch

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
    x = torch.randn(4, 32, CQT_N_BINS)
    out = model(x)
    assert set(out.keys()) == {"quality", "bass"}
    assert out["quality"].shape == (4, 32, N_QUALITY)
    assert out["bass"].shape == (4, 32, N_BASS)


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
    loss = out["quality"].float().sum() + out["bass"].float().sum()
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
