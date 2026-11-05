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

from .model.alphabet import (
    ALPHABET_SHA,
    BASS_N_INDEX,
    BASS_SAME_INDEX,
    N_BASS,
    N_INDEX,
    N_QUALITY,
    NUM_LABELS,
    NUM_ROOTS,
    QUALITY_N_INDEX,
)
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
        default="factored",
        choices=["factored", "structured", "flat170"],
        help=(
            "factored: 25 quality x 13 bass heads (v1.5 default). "
            "structured / flat170: PR-Y1.4 legacy modes."
        ),
    )
    parser.add_argument(
        "--augment-pitch-shift",
        action="store_true",
        help="Apply pitch-shift augmentation at data-load time (requires PR-Y1.3).",
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
    """Pad CQT and label sequences to the batch's longest clip.

    Accepts two label shapes per item:

    * ``(T,)`` int64: legacy flat 62-class labels (PR-Y1.4 manifest).
    * ``(T, 3)`` int64: factored (root, quality, bass) labels (PR-Y1.3 will
      emit this once Harte → factored encoding is plumbed through the
      renderer).

    Pad value for flat labels is ``N_INDEX`` (60); for factored labels the
    pad row is ``(0, QUALITY_N_INDEX, BASS_N_INDEX)``.
    """
    max_t = max(item["cqt"].shape[0] for item in batch)
    n_bins = batch[0]["cqt"].shape[1]
    b = len(batch)
    cqt = torch.zeros((b, max_t, n_bins), dtype=torch.float32)
    lengths = torch.zeros(b, dtype=torch.long)

    first_label = batch[0]["labels"]
    is_factored = first_label.dim() == 2 and first_label.shape[-1] == 3
    if is_factored:
        pad_row = torch.tensor([0, QUALITY_N_INDEX, BASS_N_INDEX], dtype=torch.long)
        labels = pad_row.unsqueeze(0).unsqueeze(0).expand(b, max_t, 3).contiguous().clone()
    else:
        labels = torch.full((b, max_t), N_INDEX, dtype=torch.long)

    for i, item in enumerate(batch):
        t = item["cqt"].shape[0]
        cqt[i, :t] = item["cqt"]
        if is_factored:
            labels[i, :t, :] = item["labels"]
        else:
            labels[i, :t] = item["labels"]
        lengths[i] = t
    return {"cqt": cqt, "labels": labels, "lengths": lengths}


# ---------------------------------------------------------------------------
# Flat-62 → factored (R, Q, B) lift
# ---------------------------------------------------------------------------

# Canonical factored quality representative for each flat-5 collapsed bucket.
# Exp A collapses sus2+sus4 → "sus"; when lifting back we land on sus4 (the more
# common surface form in the ChoCo corpus — sus4 is ~4x sus2 by token count).
_FLAT5_TO_FACTORED_QUALITY: tuple[int, ...] = (
    0,  # flat 0=maj -> factored maj
    1,  # flat 1=min -> factored min
    2,  # flat 2=dim -> factored dim
    3,  # flat 3=aug -> factored aug
    5,  # flat 4=sus -> factored sus4 (canonical representative)
)


def _lift_flat_to_factored(
    labels_flat: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Lift flat 62-class labels to factored (root, quality, bass) targets.

    This is a lossy lift (flat 62 drops 7ths, slashes, extras — see Exp A).
    PR-Y1.3 will plumb real factored targets through the data pipeline; this
    function remains as the backward-compat bridge for existing manifests
    and the pytest smoke fixtures.
    """
    is_chord = labels_flat < 60
    root = torch.where(
        is_chord,
        labels_flat // 5,
        torch.zeros_like(labels_flat),
    )
    flat_q = torch.where(
        is_chord,
        labels_flat % 5,
        torch.zeros_like(labels_flat),
    )
    flat5_to_fact = torch.tensor(
        _FLAT5_TO_FACTORED_QUALITY, dtype=labels_flat.dtype, device=labels_flat.device
    )
    quality = torch.where(
        is_chord,
        flat5_to_fact[flat_q.clamp(min=0, max=4)],
        torch.full_like(labels_flat, QUALITY_N_INDEX),
    )
    bass = torch.where(
        is_chord,
        torch.full_like(labels_flat, BASS_SAME_INDEX),
        torch.full_like(labels_flat, BASS_N_INDEX),
    )
    return root, quality, bass


# ---------------------------------------------------------------------------
# Weighted CE: γ-tempered class frequencies with a hard cap
# ---------------------------------------------------------------------------


def _weights_from_counts(
    counts: Counter[int], num_classes: int, gamma: float, w_max: float
) -> torch.Tensor:
    """Build a ``(num_classes,)`` CE-weight tensor from a frequency ``Counter``."""
    weights = torch.ones(num_classes, dtype=torch.float32)
    if not counts:
        return weights
    n_total = sum(counts.values())
    k_observed = len(counts)
    for c, n_c in counts.items():
        if 0 <= c < num_classes and n_c > 0:
            raw = (n_total / (k_observed * n_c)) ** gamma
            weights[c] = float(max(min(raw, w_max), 1.0 / w_max))
    return weights


def compute_class_weights(
    rows: list[ManifestRow],
    gamma: float = 0.7,
    w_max: float = 20.0,
) -> torch.Tensor:
    """Return a ``(NUM_LABELS,)`` tensor of per-class CE weights.

    Legacy flat-62 weighting, kept for the structured / flat170 modes.

    Weight formula: ``w_c = clip((n_total / (K * n_c))**gamma, 1/w_max, w_max)``.
    """
    counts = Counter[int]()
    for row in rows:
        try:
            labels = np.load(row.labels_npy)
        except (FileNotFoundError, OSError):
            continue
        # Flat labels only — factored (T, 3) arrays belong to the factored
        # weighting path below.
        if labels.ndim != 1:
            continue
        for lbl, cnt in Counter(labels.tolist()).items():
            counts[int(lbl)] += int(cnt)
    return _weights_from_counts(counts, NUM_LABELS, gamma, w_max)


def compute_factored_class_weights(
    rows: list[ManifestRow],
    gamma: float = 0.7,
    w_max: float = 20.0,
) -> dict[str, torch.Tensor]:
    """Return per-head CE weights for the factored output heads.

    Returns a dict ``{"root": (13,), "quality": (N_QUALITY,), "bass": (N_BASS,)}``
    of tempered per-class weights using the same γ/w_max formula as the flat
    path. For legacy flat-62 manifests the labels are lifted via
    ``_lift_flat_to_factored`` before counting.
    """
    root_counts: Counter[int] = Counter()
    quality_counts: Counter[int] = Counter()
    bass_counts: Counter[int] = Counter()

    for row in rows:
        try:
            labels = np.load(row.labels_npy)
        except (FileNotFoundError, OSError):
            continue
        if labels.ndim == 2 and labels.shape[-1] == 3:
            # Factored labels straight from disk.
            for r in labels[:, 0].tolist():
                root_counts[int(r)] += 1
            for q in labels[:, 1].tolist():
                quality_counts[int(q)] += 1
            for b in labels[:, 2].tolist():
                bass_counts[int(b)] += 1
        elif labels.ndim == 1:
            # Lift from flat 62-class.
            lbl_t = torch.from_numpy(labels.astype(np.int64))
            r_t, q_t, b_t = _lift_flat_to_factored(lbl_t)
            for r in r_t.tolist():
                root_counts[int(r)] += 1
            for q in q_t.tolist():
                quality_counts[int(q)] += 1
            for b in b_t.tolist():
                bass_counts[int(b)] += 1

    return {
        "root": _weights_from_counts(root_counts, NUM_ROOTS + 1, gamma, w_max),
        "quality": _weights_from_counts(quality_counts, N_QUALITY, gamma, w_max),
        "bass": _weights_from_counts(bass_counts, N_BASS, gamma, w_max),
    }


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


def _factored_loss_components(
    logits: dict[str, torch.Tensor],
    labels: torch.Tensor,  # (B, T) OR (B, T, 3)
    class_weights: dict[str, torch.Tensor],
    mask: torch.Tensor,  # (B, T), True where a frame is real (not padding)
) -> dict[str, torch.Tensor]:
    """Three independent weighted-CE heads for the factored alphabet.

    Returns ``{"root": loss_root, "quality": loss_quality, "bass": loss_bass,
    "total": root + quality + bass}``.

    ``labels`` is either:
        * ``(B, T)`` legacy flat 62-class — we lift via
          ``_lift_flat_to_factored`` (lossy; PR-Y1.3 will plumb real
          factored targets).
        * ``(B, T, 3)`` factored — columns ``[root, quality, bass]`` already.
    """
    root_logits = logits["root_logits"]  # (B, T, 13)
    quality_logits = logits["quality_logits"]  # (B, T, N_QUALITY)
    bass_logits = logits["bass_logits"]  # (B, T, N_BASS)

    if labels.dim() == 3 and labels.shape[-1] == 3:
        root_y = labels[..., 0]
        quality_y = labels[..., 1]
        bass_y = labels[..., 2]
    elif labels.dim() == 2:
        root_y, quality_y, bass_y = _lift_flat_to_factored(labels)
    else:
        raise ValueError(
            f"factored loss expects labels shape (B, T) or (B, T, 3); got {tuple(labels.shape)}"
        )

    frame_mask = mask.to(dtype=torch.float32)

    def _head_loss(
        head_logits: torch.Tensor,
        head_y: torch.Tensor,
        head_weights: torch.Tensor,
    ) -> torch.Tensor:
        b, t, k = head_logits.shape
        per_class_w = head_weights.to(device=head_logits.device, dtype=torch.float32)
        frame_w = per_class_w[head_y.clamp(min=0, max=k - 1)] * frame_mask
        loss = F.cross_entropy(
            head_logits.reshape(b * t, k),
            head_y.reshape(b * t).clamp(min=0, max=k - 1),
            reduction="none",
        ).reshape(b, t)
        return (loss * frame_w).sum() / frame_w.sum().clamp(min=1.0)

    loss_root = _head_loss(root_logits, root_y, class_weights["root"])
    loss_quality = _head_loss(quality_logits, quality_y, class_weights["quality"])
    loss_bass = _head_loss(bass_logits, bass_y, class_weights["bass"])
    total = loss_root + loss_quality + loss_bass
    return {
        "root": loss_root,
        "quality": loss_quality,
        "bass": loss_bass,
        "total": total,
    }


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


def compute_loss(
    logits: dict[str, torch.Tensor],
    labels: torch.Tensor,
    lengths: torch.Tensor,
    class_weights: torch.Tensor | dict[str, torch.Tensor],
    output_mode: OutputMode,
) -> torch.Tensor:
    """Weighted CE across heads, averaged over valid (unpadded) frames.

    - ``factored``: expects ``class_weights`` as the dict returned by
      ``compute_factored_class_weights`` (keys ``root``/``quality``/``bass``).
      Returns the summed total (root + quality + bass).
    - ``structured`` / ``flat170``: expects ``class_weights`` as a
      ``(NUM_LABELS,)`` tensor (``compute_class_weights`` output).
    """
    # Build the padding mask off the frame dimension (T), which is axis 1
    # whether labels are (B, T) flat or (B, T, 3) factored.
    b = labels.shape[0]
    t = labels.shape[1]
    mask = torch.arange(t, device=labels.device).unsqueeze(0) < lengths.to(labels.device).unsqueeze(
        -1
    )
    _ = b  # retained for parity with the pre-factored signature
    if output_mode == "factored":
        if not isinstance(class_weights, dict):
            raise TypeError(
                "factored compute_loss expects class_weights as a dict with keys "
                "'root', 'quality', 'bass'; got a tensor."
            )
        return _factored_loss_components(logits, labels, class_weights, mask)["total"]
    if output_mode == "structured":
        if isinstance(class_weights, dict):
            raise TypeError(
                "structured compute_loss expects class_weights as a (NUM_LABELS,) tensor."
            )
        return _structured_loss(logits, labels, class_weights, mask)
    if isinstance(class_weights, dict):
        raise TypeError("flat170 compute_loss expects class_weights as a (NUM_LABELS,) tensor.")
    return _flat170_loss(logits, labels, class_weights, mask)


def compute_loss_components(
    logits: dict[str, torch.Tensor],
    labels: torch.Tensor,
    lengths: torch.Tensor,
    class_weights: dict[str, torch.Tensor],
) -> dict[str, torch.Tensor]:
    """Factored-mode loss helper exposing the three head components + total.

    Test seam: ``_factored_loss_components`` is private; this is the public
    wrapper so test suites can assert the loss decomposes into three CE terms
    without reaching into the underscored helper.
    """
    t = labels.shape[1]
    mask = torch.arange(t, device=labels.device).unsqueeze(0) < lengths.to(labels.device).unsqueeze(
        -1
    )
    return _factored_loss_components(logits, labels, class_weights, mask)


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

    Reports (same keys across all output modes so the training log is
    consistent):

    - ``majmin``: MajMin-collapsed frame accuracy (root + {maj/min/N}).
    - ``sevenths``: proxy for 7th-detection. For ``factored`` this is
      per-quality exact match on chord frames (captures 7th / 6th / tensions
      directly). For legacy modes it is flat-5 triad accuracy, unchanged.
    - ``bass`` (factored only): bass-head accuracy on chord frames. Reported
      as 0.0 under structured / flat170 for log-schema parity.
    """
    model.eval()
    majmin_correct = 0
    majmin_total = 0
    sevenths_correct = 0
    sevenths_total = 0
    bass_correct = 0
    bass_total = 0

    for batch in loader:
        cqt = batch["cqt"].to(device)
        labels = batch["labels"].to(device)
        lengths = batch["lengths"].to(device)
        logits = model(cqt)
        pred_labels, _ = model._collapse_to_62(logits)  # noqa: SLF001 — same module

        # Normalise labels to a flat (B, T) 62-class view for the MajMin
        # proxy. Factored labels (B, T, 3) collapse back via the factored
        # → flat-5 quality table.
        if labels.dim() == 3 and labels.shape[-1] == 3:
            root_y = labels[..., 0]
            quality_y = labels[..., 1]
            bass_y = labels[..., 2]
            # Flat-5 collapse (same table as _collapse_to_62 for consistency).
            qmap = model._quality_to_flat5_table(device=device)  # noqa: SLF001
            is_n = quality_y == QUALITY_N_INDEX
            flat5_q = qmap[quality_y.clamp(min=0, max=N_QUALITY - 1)]
            flat_labels = torch.where(
                is_n,
                torch.full_like(root_y, N_INDEX),
                root_y * 5 + flat5_q,
            )
        else:
            flat_labels = labels
            root_y = None
            quality_y = None
            bass_y = None

        t = flat_labels.shape[1]
        mask = torch.arange(t, device=device).unsqueeze(0) < lengths.unsqueeze(-1)
        pred_root = torch.where(
            pred_labels < 60, pred_labels // 5, torch.full_like(pred_labels, 12)
        )
        true_root = torch.where(
            flat_labels < 60, flat_labels // 5, torch.full_like(flat_labels, 12)
        )
        pred_tri = torch.where(pred_labels < 60, pred_labels % 5, torch.zeros_like(pred_labels))
        true_tri = torch.where(flat_labels < 60, flat_labels % 5, torch.zeros_like(flat_labels))
        majmin_frames = mask & ((true_tri <= 1) | (flat_labels == N_INDEX))
        correct = (pred_root == true_root) & (pred_tri == true_tri)
        majmin_correct += int((correct & majmin_frames).sum().item())
        majmin_total += int(majmin_frames.sum().item())

        # Sevenths proxy
        if model.output_mode == "factored" and quality_y is not None:
            # Argmax quality head on all chord frames.
            quality_logits = logits["quality_logits"]
            pred_quality = quality_logits.argmax(dim=-1)
            chord_frames = mask & (flat_labels < 60)
            sevenths_correct += int(((pred_quality == quality_y) & chord_frames).sum().item())
            sevenths_total += int(chord_frames.sum().item())
            # Bass head accuracy on chord frames.
            bass_logits = logits["bass_logits"]
            pred_bass = bass_logits.argmax(dim=-1)
            bass_correct += int(((pred_bass == bass_y) & chord_frames).sum().item())
            bass_total += int(chord_frames.sum().item())
        else:
            chord_frames = mask & (flat_labels < 60)
            sevenths_correct += int(((pred_tri == true_tri) & chord_frames).sum().item())
            sevenths_total += int(chord_frames.sum().item())

    return {
        "majmin": majmin_correct / majmin_total if majmin_total > 0 else 0.0,
        "sevenths": sevenths_correct / sevenths_total if sevenths_total > 0 else 0.0,
        "bass": bass_correct / bass_total if bass_total > 0 else 0.0,
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
) -> Path:
    """Run the training loop. Returns the path to the ``best.pt`` checkpoint."""
    _set_seed(seed)
    out.mkdir(parents=True, exist_ok=True)

    manifest = data_dir / "MANIFEST.jsonl"
    if not manifest.exists():
        raise FileNotFoundError(
            f"MANIFEST.jsonl not found at {manifest}. Run PR-Y1.3's data pipeline first."
        )

    rows = _read_manifest(manifest)
    train_rows, val_rows, _test_rows = split_by_score_sha(rows, seed=seed)
    class_weights: torch.Tensor | dict[str, torch.Tensor]
    if output_mode == "factored":
        class_weights = compute_factored_class_weights(train_rows)
    else:
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

    model = ChordNet2E1D(output_mode=output_mode).to(device)
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
            loss = compute_loss(logits, labels, lengths, class_weights, output_mode)
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
                "val_bass": val_metrics.get("bass", 0.0),
                "lr": optimizer.param_groups[0]["lr"],
            },
        )

        # Checkpoint every epoch, plus a 'best' pointer.
        epoch_ckpt = out / f"epoch-{epoch:03d}.pt"
        torch.save(
            {
                "model_state": model.state_dict(),
                "epoch": epoch,
                "output_mode": output_mode,
                "alphabet_sha": ALPHABET_SHA,
                "cqt_plan_version": CQT_PLAN_VERSION,
                "val_metrics": val_metrics,
            },
            epoch_ckpt,
        )
        if val_metrics["majmin"] > best_val_majmin:
            best_val_majmin = val_metrics["majmin"]
            torch.save(
                {
                    "model_state": model.state_dict(),
                    "epoch": epoch,
                    "output_mode": output_mode,
                    "alphabet_sha": ALPHABET_SHA,
                    "cqt_plan_version": CQT_PLAN_VERSION,
                    "val_metrics": val_metrics,
                },
                best_ckpt,
            )

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
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
