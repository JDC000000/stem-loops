"""ChordNet training entry point.

PR-Y1.qa-modal: wires a minimal, real training loop for the factored ChordNet
2E1D model (``apps/training/model/chordnet_2e1d.py``).

Scope
-----
This loop is deliberately self-contained so the training pipeline can be
exercised end-to-end on Modal (and by CI smoke tests) without waiting for the
real data-loading plumbing in ``apps/training/data/*`` to land. It reads a
YAML config, builds the model, materialises a synthetic batch stream, runs
AdamW + cosine-with-warmup over the configured epoch count, and writes
checkpoints under ``checkpoint.dir``.

Wiring the real MANIFEST.jsonl → CQT → chord-label dataset into this file is a
follow-up PR; the synthetic placeholder lives in ``_SyntheticFactoredDataset``
below and is the only piece that will be swapped out.

Invocation
----------
Direct CLI::

    python -m training.train --config configs/chordnet_2e1d_v1.yaml --epochs 50

Via Modal env (see ``apps/training/modal_app.py::train_chordnet``) — the Modal
wrapper exports ``CHORDNET_CONFIG`` / ``CHORDNET_EPOCHS`` / ``CHORDNET_SEED``
/ ``CHORDNET_DATA_ROOT`` / ``CHORDNET_CHECKPOINT_DIR`` and we honour each as
a precedence-respecting override. CLI flags beat env vars; env vars beat the
config file; config beats hard-coded defaults.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import torch
import yaml  # type: ignore[import-untyped]
from torch import nn
from torch.utils.data import DataLoader, Dataset

# Works both as module (`python -m training.train`) and as script
# (`python apps/training/train.py` — the shape Modal's wrapper uses).
if __package__:
    from .model.alphabet import ROOT_N_INDEX
    from .model.chordnet_2e1d import CQT_N_BINS, N_BASS, N_QUALITY, ChordNet2E1D
else:
    _APPS_DIR = Path(__file__).resolve().parent.parent
    if str(_APPS_DIR) not in sys.path:
        sys.path.insert(0, str(_APPS_DIR))
    from training.model.alphabet import ROOT_N_INDEX  # type: ignore[no-redef]
    from training.model.chordnet_2e1d import (  # type: ignore[no-redef]
        CQT_N_BINS,
        N_BASS,
        N_QUALITY,
        ChordNet2E1D,
    )

N_ROOT: int = ROOT_N_INDEX + 1  # 13-wide root head: 12 pitch classes + no-chord

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass
class TrainConfig:
    """Flattened subset of the YAML config used by the training loop."""

    run_name: str = "chordnet_2e1d_v1"
    seed: int = 42
    max_songs: int | None = None

    n_bins: int = CQT_N_BINS
    d_model: int = 256
    gru_layers: int = 2
    dropout: float = 0.1

    batch_size: int = 32
    epochs: int = 50
    mixed_precision: bool = True
    grad_clip: float = 1.0

    lr: float = 3.0e-4
    weight_decay: float = 1.0e-4
    betas: tuple[float, float] = (0.9, 0.98)
    warmup_steps: int = 500
    min_lr_ratio: float = 0.01

    root_weight: float = 1.0
    quality_weight: float = 1.0
    bass_weight: float = 1.0
    ignore_index: int = -100

    max_frames: int = 512
    num_workers: int = 4

    eval_interval_epochs: int = 1

    checkpoint_dir: Path = field(default_factory=lambda: Path("./checkpoints"))
    keep_last: int = 5


def load_config(config_path: Path) -> TrainConfig:
    """Parse the YAML config into a ``TrainConfig`` dataclass."""
    raw: dict[str, Any] = yaml.safe_load(config_path.read_text())
    run = raw.get("run", {}) or {}
    model = raw.get("model", {}) or {}
    train = raw.get("train", {}) or {}
    optim = raw.get("optim", {}) or {}
    scheduler = raw.get("scheduler", {}) or {}
    loss = raw.get("loss", {}) or {}
    data = raw.get("data", {}) or {}
    eval_cfg = raw.get("eval", {}) or {}
    ckpt = raw.get("checkpoint", {}) or {}

    return TrainConfig(
        run_name=str(run.get("name", "chordnet_2e1d")),
        seed=int(run.get("seed", 42)),
        max_songs=run.get("max_songs"),
        n_bins=int(model.get("n_bins", CQT_N_BINS)),
        d_model=int(model.get("d_model", 256)),
        gru_layers=int(model.get("gru_layers", 2)),
        dropout=float(model.get("dropout", 0.1)),
        batch_size=int(train.get("batch_size", 32)),
        epochs=int(train.get("epochs", 50)),
        mixed_precision=bool(train.get("mixed_precision", True)),
        grad_clip=float(train.get("grad_clip", 1.0)),
        lr=float(optim.get("lr", 3.0e-4)),
        weight_decay=float(optim.get("weight_decay", 1.0e-4)),
        betas=tuple(optim.get("betas", [0.9, 0.98])),  # type: ignore[arg-type]
        warmup_steps=int(scheduler.get("warmup_steps", 500)),
        min_lr_ratio=float(scheduler.get("min_lr_ratio", 0.01)),
        root_weight=float(loss.get("root_weight", 1.0)),
        quality_weight=float(loss.get("quality_weight", 1.0)),
        bass_weight=float(loss.get("bass_weight", 1.0)),
        ignore_index=int(loss.get("ignore_index", -100)),
        max_frames=int(data.get("max_frames", 512)),
        num_workers=int(data.get("num_workers", 4)),
        eval_interval_epochs=int(eval_cfg.get("interval_epochs", 1)),
        checkpoint_dir=Path(ckpt.get("dir", "./checkpoints")),
        keep_last=int(ckpt.get("keep_last", 5)),
    )


# ---------------------------------------------------------------------------
# Synthetic placeholder dataset
# ---------------------------------------------------------------------------


class _SyntheticFactoredDataset(Dataset[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]]):
    """Tiny in-memory dataset of random CQT frames + random factored labels.

    This exists so the training loop can be *exercised* end-to-end (grad flow,
    optimizer step, checkpoint IO) before the real CQT + chord-label pipeline
    lands. It is **not** a surrogate for real training signal.

    Each sample yields:
        cqt:    (T, n_bins) float32
        root:    (T,)       int64 in [0, N_ROOT)  (12 = no-chord, ROOT_N_INDEX)
        quality: (T,)       int64 in [0, N_QUALITY)
        bass:    (T,)       int64 in [0, N_BASS)
    """

    def __init__(
        self,
        n_samples: int,
        max_frames: int,
        n_bins: int,
        seed: int = 0,
    ) -> None:
        self.n_samples = int(n_samples)
        self.max_frames = int(max_frames)
        self.n_bins = int(n_bins)
        self._rng = torch.Generator()
        self._rng.manual_seed(seed)

    def __len__(self) -> int:
        return self.n_samples

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        # Deterministic per-index sampling so DataLoader workers reproduce.
        gen = torch.Generator()
        gen.manual_seed(int(self._rng.initial_seed()) + idx)
        t = self.max_frames
        cqt = torch.randn(t, self.n_bins, generator=gen)
        root = torch.randint(0, N_ROOT, (t,), generator=gen, dtype=torch.long)
        quality = torch.randint(0, N_QUALITY, (t,), generator=gen, dtype=torch.long)
        bass = torch.randint(0, N_BASS, (t,), generator=gen, dtype=torch.long)
        return cqt, root, quality, bass


# ---------------------------------------------------------------------------
# LR schedule
# ---------------------------------------------------------------------------


def _lr_at_step(step: int, base_lr: float, warmup: int, total: int, min_ratio: float) -> float:
    """Linear warmup then cosine decay to ``min_ratio * base_lr``."""
    if warmup > 0 and step < warmup:
        return base_lr * (step + 1) / warmup
    if total <= warmup:
        return base_lr
    progress = (step - warmup) / max(1, total - warmup)
    progress = min(max(progress, 0.0), 1.0)
    cos = 0.5 * (1.0 + math.cos(math.pi * progress))
    return base_lr * (min_ratio + (1.0 - min_ratio) * cos)


# ---------------------------------------------------------------------------
# Train step / epoch
# ---------------------------------------------------------------------------


def _build_dataset(cfg: TrainConfig, split: str) -> _SyntheticFactoredDataset:
    """Build the synthetic placeholder dataset for ``split`` in {train, val}."""
    base_n = cfg.max_songs if cfg.max_songs is not None else 1024
    n_samples = base_n if split == "train" else max(8, base_n // 10)
    return _SyntheticFactoredDataset(
        n_samples=n_samples,
        max_frames=cfg.max_frames,
        n_bins=cfg.n_bins,
        seed=cfg.seed + (0 if split == "train" else 1),
    )


def train_one_step(
    model: ChordNet2E1D,
    batch: tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor],
    optimizer: torch.optim.Optimizer,
    cfg: TrainConfig,
    device: torch.device,
) -> dict[str, float]:
    """Run one optimizer step and return per-head loss values.

    Isolated so ``test_train_loop.py`` can call it with a 1-sample batch
    without instantiating the DataLoader / scheduler machinery.
    """
    cqt, r_tgt, q_tgt, b_tgt = batch
    cqt = cqt.to(device)
    r_tgt = r_tgt.to(device)
    q_tgt = q_tgt.to(device)
    b_tgt = b_tgt.to(device)

    model.train()
    # Factored contract (decision record v1.5): all three heads are supervised.
    # Loss = root_weight*CE(root) + quality_weight*CE(quality) + bass_weight*CE(bass).
    # Root targets come from encode_factored()[0]; no-chord frames carry
    # ROOT_N_INDEX (12), a real class in the 13-wide root head.
    out = model(cqt)
    r_logits = out["root_logits"].reshape(-1, N_ROOT)
    q_logits = out["quality_logits"].reshape(-1, N_QUALITY)
    b_logits = out["bass_logits"].reshape(-1, N_BASS)

    ce = nn.CrossEntropyLoss(ignore_index=cfg.ignore_index)
    r_loss = ce(r_logits, r_tgt.reshape(-1))
    q_loss = ce(q_logits, q_tgt.reshape(-1))
    b_loss = ce(b_logits, b_tgt.reshape(-1))
    loss = cfg.root_weight * r_loss + cfg.quality_weight * q_loss + cfg.bass_weight * b_loss

    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    if cfg.grad_clip > 0:
        torch.nn.utils.clip_grad_norm_(model.parameters(), cfg.grad_clip)
    optimizer.step()

    return {
        "loss": float(loss.detach().cpu()),
        "root_loss": float(r_loss.detach().cpu()),
        "quality_loss": float(q_loss.detach().cpu()),
        "bass_loss": float(b_loss.detach().cpu()),
    }


@torch.no_grad()
def eval_one_epoch(
    model: ChordNet2E1D,
    loader: DataLoader,
    cfg: TrainConfig,
    device: torch.device,
) -> dict[str, float]:
    """Compute mean per-head loss across ``loader``. CPU-safe."""
    model.eval()
    ce = nn.CrossEntropyLoss(ignore_index=cfg.ignore_index)
    totals: dict[str, float] = {"loss": 0.0, "root_loss": 0.0, "quality_loss": 0.0, "bass_loss": 0.0}
    n_batches = 0
    for cqt, r_tgt, q_tgt, b_tgt in loader:
        cqt = cqt.to(device)
        r_tgt = r_tgt.to(device)
        q_tgt = q_tgt.to(device)
        b_tgt = b_tgt.to(device)
        out = model(cqt)
        r_logits = out["root_logits"].reshape(-1, N_ROOT)
        q_logits = out["quality_logits"].reshape(-1, N_QUALITY)
        b_logits = out["bass_logits"].reshape(-1, N_BASS)
        r_loss = ce(r_logits, r_tgt.reshape(-1))
        q_loss = ce(q_logits, q_tgt.reshape(-1))
        b_loss = ce(b_logits, b_tgt.reshape(-1))
        loss = cfg.root_weight * r_loss + cfg.quality_weight * q_loss + cfg.bass_weight * b_loss
        totals["loss"] += float(loss.detach().cpu())
        totals["root_loss"] += float(r_loss.detach().cpu())
        totals["quality_loss"] += float(q_loss.detach().cpu())
        totals["bass_loss"] += float(b_loss.detach().cpu())
        n_batches += 1
    if n_batches == 0:
        return totals
    return {k: v / n_batches for k, v in totals.items()}


# ---------------------------------------------------------------------------
# Checkpointing
# ---------------------------------------------------------------------------


def save_checkpoint(path: Path, model: ChordNet2E1D, cfg: TrainConfig, epoch: int, val_loss: float) -> None:
    """Write a ``torch.save`` checkpoint with model + config snapshot."""
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model_state": model.state_dict(),
            "epoch": epoch,
            "val_loss": val_loss,
            "run_name": cfg.run_name,
            "n_bins": cfg.n_bins,
            "d_model": cfg.d_model,
            "gru_layers": cfg.gru_layers,
        },
        path,
    )


# ---------------------------------------------------------------------------
# Main train loop
# ---------------------------------------------------------------------------


def run_training(cfg: TrainConfig, device: torch.device | None = None) -> dict[str, Any]:
    """Run the full training loop. Returns a metrics summary dict."""

    random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    print(f"[train] device={device} run={cfg.run_name} epochs={cfg.epochs} batch={cfg.batch_size}")
    print(f"[train] n_bins={cfg.n_bins} d_model={cfg.d_model} gru_layers={cfg.gru_layers}")

    model = ChordNet2E1D(
        n_bins=cfg.n_bins,
        d_model=cfg.d_model,
        gru_layers=cfg.gru_layers,
        dropout=cfg.dropout,
        output_mode="factored",
    ).to(device)

    n_params = sum(p.numel() for p in model.parameters())
    print(f"[train] param_count={n_params:,}")

    train_ds = _build_dataset(cfg, "train")
    val_ds = _build_dataset(cfg, "val")

    train_loader = DataLoader(
        train_ds,
        batch_size=cfg.batch_size,
        shuffle=True,
        num_workers=cfg.num_workers,
        drop_last=True,
    )
    val_loader = DataLoader(
        val_ds,
        batch_size=cfg.batch_size,
        shuffle=False,
        num_workers=cfg.num_workers,
        drop_last=False,
    )

    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=cfg.lr,
        betas=cfg.betas,
        weight_decay=cfg.weight_decay,
    )

    total_steps = max(1, cfg.epochs * max(1, len(train_loader)))

    best_val = math.inf
    global_step = 0
    history: list[dict[str, float]] = []

    for epoch in range(1, cfg.epochs + 1):
        t0 = time.time()
        model.train()
        epoch_loss = 0.0
        batches = 0
        for batch in train_loader:
            # Manual LR schedule (keeps the deps count low — no transformers lib).
            lr = _lr_at_step(
                global_step, cfg.lr, cfg.warmup_steps, total_steps, cfg.min_lr_ratio
            )
            for g in optimizer.param_groups:
                g["lr"] = lr

            metrics = train_one_step(model, batch, optimizer, cfg, device)
            epoch_loss += metrics["loss"]
            batches += 1
            global_step += 1

        mean_train_loss = epoch_loss / max(1, batches)

        val_metrics: dict[str, float] = {}
        if epoch % cfg.eval_interval_epochs == 0:
            val_metrics = eval_one_epoch(model, val_loader, cfg, device)

        duration = time.time() - t0
        print(
            f"[train] epoch={epoch}/{cfg.epochs} "
            f"train_loss={mean_train_loss:.4f} "
            f"val_loss={val_metrics.get('loss', float('nan')):.4f} "
            f"lr={lr:.2e} "
            f"took={duration:.1f}s"
        )
        history.append(
            {
                "epoch": epoch,
                "train_loss": mean_train_loss,
                "val_loss": float(val_metrics.get("loss", math.nan)),
                "lr": lr,
            }
        )

        # Per-epoch checkpoint.
        epoch_ckpt = cfg.checkpoint_dir / f"epoch_{epoch:03d}.pt"
        save_checkpoint(epoch_ckpt, model, cfg, epoch, val_metrics.get("loss", math.nan))

        # Rolling retention.
        _prune_old_checkpoints(cfg.checkpoint_dir, keep_last=cfg.keep_last)

        # Track best.
        val_loss_now = val_metrics.get("loss", math.inf)
        if val_loss_now < best_val:
            best_val = val_loss_now
            save_checkpoint(cfg.checkpoint_dir / "best.pt", model, cfg, epoch, best_val)
            print(f"[train] new best val_loss={best_val:.4f} → best.pt")

    return {
        "best_val_loss": best_val,
        "epochs": cfg.epochs,
        "history": history,
        "param_count": n_params,
        "checkpoint_dir": str(cfg.checkpoint_dir),
    }


def _prune_old_checkpoints(ckpt_dir: Path, keep_last: int) -> None:
    """Delete older per-epoch checkpoints, keeping only the most recent ``keep_last``."""
    if keep_last <= 0:
        return
    if not ckpt_dir.exists():
        return
    epoch_ckpts = sorted(
        (p for p in ckpt_dir.glob("epoch_*.pt") if p.is_file()),
        key=lambda p: p.name,
    )
    for stale in epoch_ckpts[:-keep_last]:
        try:
            stale.unlink()
        except OSError:
            # Best-effort retention; swallow rather than crash the run.
            pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m training.train",
        description="Train the factored ChordNet 2E1D model.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to the YAML config. Falls back to $CHORDNET_CONFIG then "
        "configs/chordnet_2e1d_v1.yaml.",
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=None,
        help="Override config.train.epochs.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Override config.run.seed.",
    )
    parser.add_argument(
        "--checkpoint-dir",
        type=Path,
        default=None,
        help="Override config.checkpoint.dir.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse the config + build the model but do not iterate on data "
        "or write checkpoints. Used by test_train_loop to validate wiring.",
    )
    return parser


def _resolve_config_path(cli_path: Path | None) -> Path:
    """CLI arg > CHORDNET_CONFIG env var > default under configs/."""
    if cli_path is not None:
        return cli_path
    env = os.environ.get("CHORDNET_CONFIG")
    if env:
        return Path(env)
    # Default relative to this file so `python -m training.train` works from
    # any cwd inside the repo.
    return Path(__file__).parent / "configs" / "chordnet_2e1d_v1.yaml"


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    config_path = _resolve_config_path(args.config)
    if not config_path.exists():
        print(f"[train] config not found: {config_path}", file=sys.stderr)
        return 2

    cfg = load_config(config_path)

    # Env-var overrides (set by modal_app.py).
    if args.epochs is not None:
        cfg.epochs = args.epochs
    elif os.environ.get("CHORDNET_EPOCHS"):
        cfg.epochs = int(os.environ["CHORDNET_EPOCHS"])

    if args.seed is not None:
        cfg.seed = args.seed
    elif os.environ.get("CHORDNET_SEED"):
        cfg.seed = int(os.environ["CHORDNET_SEED"])

    if args.checkpoint_dir is not None:
        cfg.checkpoint_dir = args.checkpoint_dir
    elif os.environ.get("CHORDNET_CHECKPOINT_DIR"):
        cfg.checkpoint_dir = Path(os.environ["CHORDNET_CHECKPOINT_DIR"])

    if args.dry_run:
        # Build the model + parse the config but don't iterate.
        _ = ChordNet2E1D(
            n_bins=cfg.n_bins,
            d_model=cfg.d_model,
            gru_layers=cfg.gru_layers,
            dropout=cfg.dropout,
            output_mode="factored",
        )
        print(f"[train] dry-run OK: config={config_path}")
        return 0

    summary = run_training(cfg)
    print(f"[train] done: best_val_loss={summary['best_val_loss']:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
