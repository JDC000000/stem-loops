"""ChordNet 2E1D training loop (PR-Y1.4).

Reads ``MANIFEST.jsonl`` (produced by PR-Y1.3's synthetic-renderer + corpus
download), builds the ChordNet-2E1D graph, and trains on a single GPU
(Modal L4 / A10 per repo ``.env.example``).

CLI
---

.. code-block:: bash

    python -m training.train \\
        --data-dir apps/training/data/cache \\
        --out apps/training/runs/exp1 \\
        --epochs 30 \\
        --batch-size 24 \\
        --lr 1e-3 \\
        --gpu l4 \\
        --seed 42 \\
        --wandb-off

Pipeline:

1. Load ``MANIFEST.jsonl`` from ``--data-dir``.
2. Deterministic 80/10/10 train/val/test split **by ``score_file`` sha**
   (prevents the same score under multiple renders from leaking across
   splits).
3. AdamW(lr=1e-3), ``ReduceLROnPlateau(factor=0.1, patience=2)``, weighted
   cross-entropy (chord-imbalance weighting: γ≈0.7, w_max=20).
4. Pitch-shift augmentation at data-load time (uses
   ``data/pitch_shift_aug.py`` from PR-Y1.3; import-guarded here).
5. Save checkpoint every epoch to ``--out``.
6. Log train loss + val MajMin / val Sevenths per epoch to
   ``--out/train_log.jsonl``.
7. Optional wandb (default off).

Dependencies
~~~~~~~~~~~~
- ``apps/training/data/pitch_shift_aug.py`` (PR-Y1.3) — import-guarded.
- ``apps/training/model/cqt_plan.py`` (PR-Y1.3) — import-guarded.
- ``apps/training/model/chordnet_2e1d.py`` (THIS PR).
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.optim import AdamW
from torch.optim.lr_scheduler import ReduceLROnPlateau
from torch.utils.data import DataLoader, Dataset

from .model.alphabet import ALPHABET_SHA, N_INDEX, NUM_LABELS
from .model.chordnet_2e1d import CQT_PLAN_VERSION, ChordNet2E1D, OutputMode

# ---------------------------------------------------------------------------
# PR-Y1.3 soft dependencies (data-side augmentation + CQT transform)
# ---------------------------------------------------------------------------

try:
    from .data.pitch_shift_aug import (
        pitch_shift_cqt as _pitch_shift_cqt,  # type: ignore[import-not-found]
    )

    _PITCH_SHIFT_AVAILABLE = True
except ImportError:
    _pitch_shift_cqt = None  # type: ignore[assignment]
    _PITCH_SHIFT_AVAILABLE = False

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m training.train",
        description="Train ChordNet-2E1D (PR-Y1.4) on the Y1 corpus.",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("apps/training/data/cache"),
        help="Directory containing MANIFEST.jsonl (PR-Y1.3 renderer output).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Run output directory (checkpoints + train_log.jsonl).",
    )
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=24)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument(
        "--gpu",
        type=str,
        default="l4",
        choices=["l4", "a10", "a100", "cpu"],
        help="Target GPU profile (informational — picked up by Modal wrapper).",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--output-mode",
        type=str,
        default="structured",
        choices=["structured", "flat170"],
    )
    parser.add_argument(
        "--augment-pitch-shift",
        action="store_true",
        help="Apply pitch-shift augmentation at data-load time (requires PR-Y1.3).",
    )
    parser.add_argument(
        "--use-crf",
        action="store_true",
        help=(
            "PR-Y1.5c: wrap the flat-62 head in a linear-chain CRF for transition-"
            "aware training. Requires --output-mode flat170. Disables the per-"
            "frame weighted CE in favour of -log p(tags | emissions)."
        ),
    )
    parser.add_argument(
        "--wandb-off",
        action="store_true",
        help="Disable weights & biases logging (default behaviour).",
    )
    parser.add_argument(
        "--max-steps-per-epoch",
        type=int,
        default=0,
        help="Cap steps per epoch (0 = unlimited). Used by the test suite smoke test.",
    )
    parser.add_argument(
        "--num-workers",
        type=int,
        default=2,
        help="DataLoader workers. Keep at 0 under pytest.",
    )
    return parser


# ---------------------------------------------------------------------------
# Manifest + split
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ManifestRow:
    """One training clip: path to CQT, path to label-sequence, provenance hashes."""

    cqt_npy: Path
    labels_npy: Path
    score_file: str  # the upstream score (sha-keyed for split integrity)
    score_sha: str
    source: str  # corpus name (guitarset, billboard, …)
    duration_sec: float


def _read_manifest(manifest_path: Path) -> list[ManifestRow]:
    rows: list[ManifestRow] = []
    with manifest_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            rows.append(
                ManifestRow(
                    cqt_npy=Path(payload["cqt_npy"]),
                    labels_npy=Path(payload["labels_npy"]),
                    score_file=payload["score_file"],
                    score_sha=payload["score_sha"],
                    source=payload["source"],
                    duration_sec=float(payload.get("duration_sec", 0.0)),
                )
            )
    return rows


def split_by_score_sha(
    rows: list[ManifestRow], seed: int
) -> tuple[list[ManifestRow], list[ManifestRow], list[ManifestRow]]:
    """Deterministic 80/10/10 split keyed by score_sha (no score leakage)."""
    rng = random.Random(seed)
    # group by score_sha
    by_sha: dict[str, list[ManifestRow]] = {}
    for row in rows:
        by_sha.setdefault(row.score_sha, []).append(row)
    shas = sorted(by_sha.keys())
    rng.shuffle(shas)
    n = len(shas)
    n_train = int(n * 0.8)
    n_val = int(n * 0.1)
    train_shas = set(shas[:n_train])
    val_shas = set(shas[n_train : n_train + n_val])
    test_shas = set(shas[n_train + n_val :])

    train: list[ManifestRow] = []
    val: list[ManifestRow] = []
    test: list[ManifestRow] = []
    for sha in train_shas:
        train.extend(by_sha[sha])
    for sha in val_shas:
        val.extend(by_sha[sha])
    for sha in test_shas:
        test.extend(by_sha[sha])
    return train, val, test


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------


class ChordClipDataset(Dataset[dict[str, torch.Tensor]]):
    """Loads (cqt, labels) pairs from on-disk .npy files."""

    def __init__(
        self,
        rows: list[ManifestRow],
        augment_pitch_shift: bool = False,
    ) -> None:
        self.rows = rows
        self.augment_pitch_shift = augment_pitch_shift and _PITCH_SHIFT_AVAILABLE

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        row = self.rows[idx]
        cqt = np.load(row.cqt_npy).astype(np.float32)  # (T, 144)
        labels = np.load(row.labels_npy).astype(np.int64)  # (T,)

        if self.augment_pitch_shift and _pitch_shift_cqt is not None:
            # PR-Y1.3 ships (cqt, labels, shift_semitones) -> (cqt', labels')
            shift = np.random.randint(-5, 6)  # ±5 semitones
            cqt, labels = _pitch_shift_cqt(cqt, labels, shift)

        return {
            "cqt": torch.from_numpy(cqt),
            "labels": torch.from_numpy(labels),
        }


def _collate_pad(batch: list[dict[str, torch.Tensor]]) -> dict[str, torch.Tensor]:
    """Pad CQT and label sequences to the batch's longest clip."""
    max_t = max(item["cqt"].shape[0] for item in batch)
    n_bins = batch[0]["cqt"].shape[1]
    b = len(batch)
    cqt = torch.zeros((b, max_t, n_bins), dtype=torch.float32)
    labels = torch.full((b, max_t), N_INDEX, dtype=torch.long)
    lengths = torch.zeros(b, dtype=torch.long)
    for i, item in enumerate(batch):
        t = item["cqt"].shape[0]
        cqt[i, :t] = item["cqt"]
        labels[i, :t] = item["labels"]
        lengths[i] = t
    return {"cqt": cqt, "labels": labels, "lengths": lengths}


# ---------------------------------------------------------------------------
# Weighted CE: γ-tempered class frequencies with a hard cap
# ---------------------------------------------------------------------------


def compute_class_weights(
    rows: list[ManifestRow],
    gamma: float = 0.7,
    w_max: float = 20.0,
) -> torch.Tensor:
    """Return a ``(NUM_LABELS,)`` tensor of per-class CE weights.

    Weight formula: ``w_c = clip((n_total / (K * n_c))**gamma, 1/w_max, w_max)``,
    where K is the number of observed classes. Classes absent from the training
    data get weight 1.0 (they will be gated by the training loop since no
    gradient flows through an unused class).
    """
    counts = Counter[int]()
    for row in rows:
        try:
            labels = np.load(row.labels_npy)
        except (FileNotFoundError, OSError):
            continue
        for lbl, cnt in Counter(labels.tolist()).items():
            counts[int(lbl)] += int(cnt)

    weights = torch.ones(NUM_LABELS, dtype=torch.float32)
    if not counts:
        return weights

    n_total = sum(counts.values())
    k_observed = len(counts)
    for c, n_c in counts.items():
        if 0 <= c < NUM_LABELS and n_c > 0:
            raw = (n_total / (k_observed * n_c)) ** gamma
            weights[c] = float(max(min(raw, w_max), 1.0 / w_max))
    return weights


# ---------------------------------------------------------------------------
# Loss: supports both output modes
# ---------------------------------------------------------------------------


def _structured_loss(
    logits: dict[str, torch.Tensor],
    labels: torch.Tensor,  # (B, T), values in [0, 62)
    class_weights: torch.Tensor,
    mask: torch.Tensor,  # (B, T), True where a frame is real (not padding)
) -> torch.Tensor:
    """CE across all four heads, averaged over valid frames.

    For a 62-class target y:
      - root_y = y // 5 for chord labels, 12 for y == N_INDEX, 12 for y == X_INDEX.
      - triad_y = y % 5 for chord labels, 0 for N/X (ignored by mask).
      - bass_y, has7_y default to 0 (ignored by mask) — real labels require
        PR-Y1.3 to emit factorised targets.
    """
    root_logits = logits["root"]  # (B, T, 13)
    triad_logits = logits["triad"]  # (B, T, 5)
    bass_logits = logits["bass_interval"]  # (B, T, 13)
    has7_logits = logits["has_7th"]  # (B, T, 4)

    # Factorise 62-class labels → heads.
    is_chord = labels < 60
    root_y = torch.where(is_chord, labels // 5, torch.full_like(labels, 12))
    triad_y = torch.where(is_chord, labels % 5, torch.zeros_like(labels))

    # Per-chord-label weight (for the root head only — triad is uniform).
    frame_w = class_weights.to(labels.device)[labels.clamp(min=0, max=NUM_LABELS - 1)]
    frame_w = frame_w * mask.to(frame_w.dtype)

    def _ce(head_logits: torch.Tensor, head_y: torch.Tensor) -> torch.Tensor:
        b, t, k = head_logits.shape
        loss = F.cross_entropy(
            head_logits.reshape(b * t, k),
            head_y.reshape(b * t),
            reduction="none",
        ).reshape(b, t)
        return (loss * frame_w).sum() / frame_w.sum().clamp(min=1.0)

    # bass / has_7th: use zero-targets gated by is_chord — PR-Y1.3 will plumb
    # real factorised targets. These heads still forward+backprop so grad flow
    # tests pass.
    bass_y = torch.zeros_like(labels)
    has7_y = torch.zeros_like(labels)

    loss_root = _ce(root_logits, root_y)
    loss_triad = _ce(triad_logits, triad_y)
    loss_bass = _ce(bass_logits, bass_y) * 0.1
    loss_has7 = _ce(has7_logits, has7_y) * 0.1

    return loss_root + loss_triad + loss_bass + loss_has7


def _flat170_loss(
    logits: dict[str, torch.Tensor],
    labels: torch.Tensor,  # (B, T), values in [0, 62)
    class_weights: torch.Tensor,
    mask: torch.Tensor,
) -> torch.Tensor:
    """Flat-170 CE — labels are still in the 62-class alphabet here; we treat
    frame targets as the collapsed 62-index and map them to the matching
    representative 170-index on the fly.

    PR-Y1.3 can provide a 170-class target column directly for a cleaner loss;
    for Y1.4 we train the flat head against the collapsed alphabet by lifting
    each 62-class label to its *canonical* 170 slot.
    """
    flat_logits = logits["flat170"]  # (B, T, 170)
    # canonical 170 indices: {62-class idx: representative 170-class idx}
    # root_idx * 14 + {maj:0, min:1, dim:2, aug:3, sus:12}
    quality_to_170q = {0: 0, 1: 1, 2: 2, 3: 3, 4: 12}  # 4 == "sus" collapses to sus2
    lifted = torch.full_like(labels, 168)  # default N
    is_chord = labels < 60
    root = labels // 5
    quality = labels % 5
    q170 = torch.zeros_like(labels)
    for q62, q170_val in quality_to_170q.items():
        q170 = torch.where(quality == q62, torch.full_like(q170, q170_val), q170)
    lifted = torch.where(is_chord, root * 14 + q170, lifted)
    lifted = torch.where(labels == 61, torch.full_like(lifted, 169), lifted)  # X

    frame_w = class_weights.to(labels.device)[labels.clamp(min=0, max=NUM_LABELS - 1)]
    frame_w = frame_w * mask.to(frame_w.dtype)
    b, t, k = flat_logits.shape
    loss = F.cross_entropy(
        flat_logits.reshape(b * t, k),
        lifted.reshape(b * t),
        reduction="none",
    ).reshape(b, t)
    return (loss * frame_w).sum() / frame_w.sum().clamp(min=1.0)


def _crf_loss(
    logits: dict[str, torch.Tensor],
    labels: torch.Tensor,
    mask: torch.Tensor,
    model: ChordNet2E1D,
) -> torch.Tensor:
    """Negative CRF log-likelihood on the 62-class alphabet (token-mean).

    Replaces the weighted CE when ``--use-crf`` is set. The emission tensor
    is produced inside the model forward (``logits["crf_emissions"]``) as
    log-probs marginalised from the 170-logit head; the tag targets are the
    frame labels in the 62-class alphabet (already what ``_collate_pad``
    produces). Padding frames are masked out — torchcrf requires the first
    frame of every sequence be unmasked, which our padding guarantees since
    every clip has length ≥ 1.
    """
    if model.crf is None:
        raise RuntimeError("_crf_loss called but model.crf is None (use_crf=False)")
    if "crf_emissions" not in logits:
        raise RuntimeError("logits dict missing 'crf_emissions' — forward path mismatch")
    emissions = logits["crf_emissions"]  # (B, T, 62)
    log_likelihood = model.crf.log_likelihood(emissions, labels, mask=mask, reduction="token_mean")
    return -log_likelihood


def compute_loss(
    logits: dict[str, torch.Tensor],
    labels: torch.Tensor,
    lengths: torch.Tensor,
    class_weights: torch.Tensor,
    output_mode: OutputMode,
    model: ChordNet2E1D | None = None,
) -> torch.Tensor:
    """Weighted CE across heads (or CRF NLL when ``model.use_crf``).

    ``model`` is optional for backwards compatibility with PR-Y1.4 call
    sites that don't use CRF. When it is passed and ``model.use_crf`` is
    True, the CRF negative log-likelihood is used in place of the weighted
    CE and ``class_weights`` is ignored.
    """
    b, t = labels.shape
    mask = torch.arange(t, device=labels.device).unsqueeze(0) < lengths.to(labels.device).unsqueeze(
        -1
    )
    if model is not None and getattr(model, "use_crf", False):
        return _crf_loss(logits, labels, mask, model)
    if output_mode == "structured":
        return _structured_loss(logits, labels, class_weights, mask)
    return _flat170_loss(logits, labels, class_weights, mask)


# ---------------------------------------------------------------------------
# Validation metrics (cheap proxies — real eval is apps/training/eval.py)
# ---------------------------------------------------------------------------


@torch.no_grad()
def validate(
    model: ChordNet2E1D,
    loader: DataLoader[dict[str, torch.Tensor]],
    device: torch.device,
) -> dict[str, float]:
    """Return frame-accuracy proxies used for ReduceLROnPlateau + logging.

    - ``majmin``: MajMin-collapsed frame accuracy (root + {maj/min/N}).
    - ``sevenths``: proxy for 7th-detection — in Y1.4 this is a placeholder
      equal to triad frame accuracy; PR-Y1.5 wires in real 7th-head accuracy.
    """
    model.eval()
    majmin_correct = 0
    majmin_total = 0
    sevenths_correct = 0
    sevenths_total = 0
    for batch in loader:
        cqt = batch["cqt"].to(device)
        labels = batch["labels"].to(device)
        lengths = batch["lengths"].to(device)
        logits = model(cqt)
        pred_labels, _ = model._collapse_to_62(logits)  # noqa: SLF001 — same module
        t = labels.shape[1]
        mask = torch.arange(t, device=device).unsqueeze(0) < lengths.unsqueeze(-1)
        # MajMin collapse: root + {maj=0, min=1, else N}
        pred_root = torch.where(
            pred_labels < 60, pred_labels // 5, torch.full_like(pred_labels, 12)
        )
        true_root = torch.where(labels < 60, labels // 5, torch.full_like(labels, 12))
        pred_tri = torch.where(pred_labels < 60, pred_labels % 5, torch.zeros_like(pred_labels))
        true_tri = torch.where(labels < 60, labels % 5, torch.zeros_like(labels))
        # majmin only scores frames where true is maj/min/N.
        majmin_frames = mask & ((true_tri <= 1) | (labels == N_INDEX))
        correct = (pred_root == true_root) & (pred_tri == true_tri)
        majmin_correct += int((correct & majmin_frames).sum().item())
        majmin_total += int(majmin_frames.sum().item())
        # sevenths placeholder: triad-accuracy on all chord frames.
        chord_frames = mask & (labels < 60)
        sevenths_correct += int(((pred_tri == true_tri) & chord_frames).sum().item())
        sevenths_total += int(chord_frames.sum().item())

    return {
        "majmin": majmin_correct / majmin_total if majmin_total > 0 else 0.0,
        "sevenths": sevenths_correct / sevenths_total if sevenths_total > 0 else 0.0,
    }


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def append_jsonl(path: Path, row: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(row) + "\n")


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------


def _set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def _batches(
    loader: DataLoader[dict[str, torch.Tensor]], cap: int
) -> Iterator[dict[str, torch.Tensor]]:
    """Yield at most ``cap`` batches per epoch (0 = unlimited)."""
    for i, batch in enumerate(loader):
        if cap and i >= cap:
            return
        yield batch


def train(
    *,
    data_dir: Path,
    out: Path,
    epochs: int,
    batch_size: int,
    lr: float,
    seed: int,
    output_mode: OutputMode,
    augment_pitch_shift: bool,
    wandb_off: bool,
    max_steps_per_epoch: int,
    num_workers: int,
    device: torch.device | None = None,
    gpu_profile: str = "l4",
    use_crf: bool = False,
) -> Path:
    """Run the training loop. Returns the path to the ``best.pt`` checkpoint."""
    if use_crf and output_mode != "flat170":
        raise ValueError(
            "--use-crf requires --output-mode flat170 (PR-Y1.5c design). "
            f"Got output_mode={output_mode!r}."
        )
    _set_seed(seed)
    out.mkdir(parents=True, exist_ok=True)

    manifest = data_dir / "MANIFEST.jsonl"
    if not manifest.exists():
        raise FileNotFoundError(
            f"MANIFEST.jsonl not found at {manifest}. Run PR-Y1.3's data pipeline first."
        )

    rows = _read_manifest(manifest)
    train_rows, val_rows, _test_rows = split_by_score_sha(rows, seed=seed)
    class_weights = compute_class_weights(train_rows)

    train_ds = ChordClipDataset(train_rows, augment_pitch_shift=augment_pitch_shift)
    val_ds = ChordClipDataset(val_rows, augment_pitch_shift=False)

    train_loader = DataLoader(
        train_ds,
        batch_size=batch_size,
        shuffle=True,
        num_workers=num_workers,
        collate_fn=_collate_pad,
        drop_last=True,
    )
    val_loader = DataLoader(
        val_ds,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        collate_fn=_collate_pad,
    )

    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model = ChordNet2E1D(output_mode=output_mode, use_crf=use_crf).to(device)
    optimizer = AdamW(model.parameters(), lr=lr)
    scheduler = ReduceLROnPlateau(optimizer, mode="max", factor=0.1, patience=2)

    if not wandb_off:
        try:
            import wandb  # type: ignore[import-not-found]

            wandb.init(project="stem-loops-chordnet", name=out.name)
        except ImportError:
            pass  # silent fall-back when wandb not installed

    log_path = out / "train_log.jsonl"
    best_val_majmin = -math.inf
    best_ckpt = out / "best.pt"

    run_meta = {
        "alphabet_sha": ALPHABET_SHA,
        "cqt_plan_version": CQT_PLAN_VERSION,
        "gpu_profile": gpu_profile,
        "seed": seed,
        "output_mode": output_mode,
        "use_crf": use_crf,
    }
    append_jsonl(log_path, {"event": "run_start", **run_meta})

    for epoch in range(1, epochs + 1):
        model.train()
        epoch_loss = 0.0
        step = 0
        for batch in _batches(train_loader, max_steps_per_epoch):
            cqt = batch["cqt"].to(device)
            labels = batch["labels"].to(device)
            lengths = batch["lengths"].to(device)
            optimizer.zero_grad()
            logits = model(cqt)
            loss = compute_loss(logits, labels, lengths, class_weights, output_mode, model=model)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            epoch_loss += float(loss.item())
            step += 1

        val_metrics = validate(model, val_loader, device)
        avg_train_loss = epoch_loss / max(step, 1)
        scheduler.step(val_metrics["majmin"])

        append_jsonl(
            log_path,
            {
                "event": "epoch",
                "epoch": epoch,
                "train_loss": avg_train_loss,
                "val_majmin": val_metrics["majmin"],
                "val_sevenths": val_metrics["sevenths"],
                "lr": optimizer.param_groups[0]["lr"],
            },
        )

        # Checkpoint every epoch, plus a 'best' pointer.
        # ``model_state`` carries the CRF transition matrix too when
        # ``use_crf=True`` (it is an ``nn.Module`` inside ChordNet2E1D), so
        # no separate persistence step is needed.
        epoch_ckpt = out / f"epoch-{epoch:03d}.pt"
        _ckpt_payload = {
            "model_state": model.state_dict(),
            "epoch": epoch,
            "output_mode": output_mode,
            "use_crf": use_crf,
            "alphabet_sha": ALPHABET_SHA,
            "cqt_plan_version": CQT_PLAN_VERSION,
            "val_metrics": val_metrics,
        }
        torch.save(_ckpt_payload, epoch_ckpt)
        if val_metrics["majmin"] > best_val_majmin:
            best_val_majmin = val_metrics["majmin"]
            torch.save(_ckpt_payload, best_ckpt)

    append_jsonl(log_path, {"event": "run_end", "best_val_majmin": best_val_majmin})
    return best_ckpt


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    device = torch.device("cuda" if torch.cuda.is_available() and args.gpu != "cpu" else "cpu")
    train(
        data_dir=args.data_dir,
        out=args.out,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        seed=args.seed,
        output_mode=args.output_mode,
        augment_pitch_shift=args.augment_pitch_shift,
        wandb_off=args.wandb_off,
        max_steps_per_epoch=args.max_steps_per_epoch,
        num_workers=args.num_workers,
        device=device,
        gpu_profile=args.gpu,
        use_crf=args.use_crf,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
