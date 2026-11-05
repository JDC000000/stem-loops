"""Smoke tests for ``training.train`` — construct + one step + checkpoint IO.

These tests do NOT hit Modal or any real audio corpus — they use the
synthetic placeholder dataset inside ``train.py`` and run a single optimizer
step so CI stays CPU-only.
"""

from __future__ import annotations

from pathlib import Path

import torch

from training.model.chordnet_2e1d import CQT_N_BINS, ChordNet2E1D
from training.train import (
    TrainConfig,
    _lr_at_step,
    build_arg_parser,
    eval_one_epoch,
    load_config,
    run_training,
    save_checkpoint,
    train_one_step,
)


# ---------------------------------------------------------------------------
# Config parsing
# ---------------------------------------------------------------------------


_REPO_TRAINING_ROOT = Path(__file__).resolve().parents[1]


def test_v1_full_config_loads() -> None:
    cfg = load_config(_REPO_TRAINING_ROOT / "configs" / "chordnet_2e1d_v1.yaml")
    assert cfg.run_name == "chordnet_2e1d_v1"
    assert cfg.epochs == 50
    assert cfg.batch_size == 32
    assert cfg.n_bins == CQT_N_BINS
    assert cfg.mixed_precision is True
    assert cfg.warmup_steps == 500


def test_smoke_config_loads() -> None:
    cfg = load_config(_REPO_TRAINING_ROOT / "configs" / "chordnet_2e1d_v1_smoke100.yaml")
    assert cfg.run_name == "chordnet_2e1d_v1_smoke100"
    # Smoke config overrides.
    assert cfg.epochs == 2
    assert cfg.batch_size == 8
    assert cfg.max_songs == 100
    # Kept at defaults for model geometry.
    assert cfg.n_bins == CQT_N_BINS


# ---------------------------------------------------------------------------
# One optimizer step
# ---------------------------------------------------------------------------


def test_train_one_step_reduces_loss_on_repeated_call() -> None:
    """A single step must at least execute and produce finite losses."""
    torch.manual_seed(0)
    device = torch.device("cpu")
    model = ChordNet2E1D(d_model=32, gru_layers=1).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    cfg = TrainConfig(d_model=32, gru_layers=1, grad_clip=1.0)

    T = 8
    batch = (
        torch.randn(2, T, CQT_N_BINS),
        torch.randint(0, 13, (2, T)),
        torch.randint(0, 25, (2, T)),
        torch.randint(0, 13, (2, T)),
    )
    first = train_one_step(model, batch, optimizer, cfg, device)
    for _ in range(3):
        second = train_one_step(model, batch, optimizer, cfg, device)

    assert torch.isfinite(torch.tensor(first["loss"])).item()
    assert torch.isfinite(torch.tensor(second["loss"])).item()
    # Overfitting a single batch should at least trend down on four steps.
    assert second["loss"] <= first["loss"] + 1e-3


def test_train_one_step_populates_grads() -> None:
    torch.manual_seed(0)
    device = torch.device("cpu")
    model = ChordNet2E1D(d_model=32, gru_layers=1).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    cfg = TrainConfig(d_model=32, gru_layers=1)

    T = 4
    batch = (
        torch.randn(1, T, CQT_N_BINS),
        torch.randint(0, 13, (1, T)),
        torch.randint(0, 25, (1, T)),
        torch.randint(0, 13, (1, T)),
    )
    _ = train_one_step(model, batch, optimizer, cfg, device)
    for _name, p in model.named_parameters():
        # post-step grads are kept until zero_grad so we can inspect them.
        if p.grad is not None:
            assert torch.isfinite(p.grad).all()


def test_train_loss_is_weighted_sum_of_root_quality_and_bass_heads() -> None:
    """Loss = rw*root + qw*quality + bw*bass over the three factored heads."""
    torch.manual_seed(0)
    device = torch.device("cpu")
    model = ChordNet2E1D(d_model=16, gru_layers=1).to(device)
    assert model.output_mode == "factored"
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    cfg = TrainConfig(d_model=16, gru_layers=1, root_weight=1.5, quality_weight=2.0, bass_weight=0.5)

    T = 4
    batch = (
        torch.randn(2, T, CQT_N_BINS),
        torch.randint(0, 13, (2, T)),
        torch.randint(0, 25, (2, T)),
        torch.randint(0, 13, (2, T)),
    )
    m = train_one_step(model, batch, optimizer, cfg, device)
    assert set(m) == {"loss", "root_loss", "quality_loss", "bass_loss"}
    expected = (
        cfg.root_weight * m["root_loss"]
        + cfg.quality_weight * m["quality_loss"]
        + cfg.bass_weight * m["bass_loss"]
    )
    assert abs(m["loss"] - expected) < 1e-5


def test_root_head_receives_gradient() -> None:
    """Regression: root_logits used to get no gradient (root head untrained)."""
    torch.manual_seed(0)
    device = torch.device("cpu")
    model = ChordNet2E1D(d_model=16, gru_layers=1).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    cfg = TrainConfig(d_model=16, gru_layers=1, grad_clip=0.0)
    T = 4
    batch = (
        torch.randn(2, T, CQT_N_BINS),
        torch.randint(0, 13, (2, T)),
        torch.randint(0, 25, (2, T)),
        torch.randint(0, 13, (2, T)),
    )
    train_one_step(model, batch, optimizer, cfg, device)
    root_params = [p for n, p in model.named_parameters() if "root" in n]
    assert root_params
    assert all(p.grad is not None and p.grad.abs().sum() > 0 for p in root_params)


def test_load_config_reads_root_weight(tmp_path) -> None:
    cfg_file = tmp_path / "c.yaml"
    cfg_file.write_text("loss:\n  root_weight: 0.25\n")
    assert load_config(cfg_file).root_weight == 0.25
    assert load_config(Path(__file__).parent.parent / "configs" / "chordnet_2e1d_v1.yaml").root_weight == 1.0


def test_synthetic_dataset_yields_root_quality_bass() -> None:
    from training.train import _SyntheticFactoredDataset

    cqt, root, quality, bass = _SyntheticFactoredDataset(2, 6, CQT_N_BINS)[0]
    assert cqt.shape == (6, CQT_N_BINS)
    assert root.shape == quality.shape == bass.shape == (6,)
    assert int(root.max()) <= 12


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------


def test_lr_at_step_warmup_then_cosine() -> None:
    # During warmup, lr scales linearly.
    assert _lr_at_step(0, 1.0, warmup=100, total=1000, min_ratio=0.1) < 0.05
    assert _lr_at_step(49, 1.0, warmup=100, total=1000, min_ratio=0.1) < 0.6
    # At warmup end, lr ≈ base.
    at_warmup = _lr_at_step(99, 1.0, warmup=100, total=1000, min_ratio=0.1)
    assert 0.9 < at_warmup <= 1.0
    # End of training decays to min_ratio.
    end = _lr_at_step(1000, 1.0, warmup=100, total=1000, min_ratio=0.1)
    assert abs(end - 0.1) < 1e-6


# ---------------------------------------------------------------------------
# Checkpoint IO
# ---------------------------------------------------------------------------


def test_save_and_reload_checkpoint(tmp_path: Path) -> None:
    model = ChordNet2E1D(d_model=32, gru_layers=1)
    cfg = TrainConfig(d_model=32, gru_layers=1, checkpoint_dir=tmp_path)
    ckpt_path = tmp_path / "epoch_001.pt"
    save_checkpoint(ckpt_path, model, cfg, epoch=1, val_loss=0.123)
    assert ckpt_path.exists()
    loaded = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    assert loaded["epoch"] == 1
    assert loaded["val_loss"] == 0.123
    assert "model_state" in loaded
    # State dict should round-trip into a fresh model.
    fresh = ChordNet2E1D(d_model=32, gru_layers=1)
    fresh.load_state_dict(loaded["model_state"])


# ---------------------------------------------------------------------------
# run_training end-to-end on a tiny config (1 epoch, 2 samples).
# ---------------------------------------------------------------------------


def test_run_training_tiny_endtoend(tmp_path: Path) -> None:
    cfg = TrainConfig(
        run_name="unit_smoke",
        seed=0,
        d_model=16,
        gru_layers=1,
        batch_size=2,
        epochs=1,
        mixed_precision=False,
        num_workers=0,
        max_frames=4,
        max_songs=4,
        warmup_steps=1,
        eval_interval_epochs=1,
        checkpoint_dir=tmp_path,
        keep_last=1,
    )
    summary = run_training(cfg, device=torch.device("cpu"))
    assert summary["epochs"] == 1
    assert summary["param_count"] > 0
    # best.pt and at least one epoch_*.pt should exist.
    assert (tmp_path / "best.pt").exists()
    epoch_ckpts = list(tmp_path.glob("epoch_*.pt"))
    assert len(epoch_ckpts) == 1


# ---------------------------------------------------------------------------
# Argparser + dry-run contract (used by the modal_app.py wrapper)
# ---------------------------------------------------------------------------


def test_argparser_accepts_core_flags() -> None:
    parser = build_arg_parser()
    ns = parser.parse_args(["--epochs", "7", "--seed", "11", "--dry-run"])
    assert ns.epochs == 7
    assert ns.seed == 11
    assert ns.dry_run is True


def test_eval_one_epoch_returns_finite_loss() -> None:
    torch.manual_seed(0)
    device = torch.device("cpu")
    model = ChordNet2E1D(d_model=16, gru_layers=1).to(device)
    cfg = TrainConfig(d_model=16, gru_layers=1)

    class _Mini:
        def __iter__(self):
            T = 4
            yield (
                torch.randn(1, T, CQT_N_BINS),
                torch.randint(0, 13, (1, T)),
                torch.randint(0, 25, (1, T)),
                torch.randint(0, 13, (1, T)),
            )

    metrics = eval_one_epoch(model, _Mini(), cfg, device)  # type: ignore[arg-type]
    assert torch.isfinite(torch.tensor(metrics["loss"])).item()
