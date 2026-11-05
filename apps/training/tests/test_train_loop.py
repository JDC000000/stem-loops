"""Training-loop smoke test — 3 steps on synthetic data, then save+reload.

CPU-only. No network. No dataset download. No GPU.
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

import numpy as np
import pytest
import torch

from training.model.alphabet import N_BASS, N_QUALITY, NUM_ROOTS
from training.model.chordnet_2e1d import CQT_N_BINS, ChordNet2E1D
from training.train import (
    compute_class_weights,
    compute_factored_class_weights,
    compute_loss,
    compute_loss_components,
    train,
)


def _write_synthetic_dataset(root: Path, n_clips: int, frames_per_clip: int) -> None:
    """Write (cqt_i.npy, labels_i.npy, MANIFEST.jsonl) into ``root``.

    Labels are drawn from the 62-class alphabet so the weighted CE path
    exercises every branch (chord + N frames at a minimum).
    """
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "MANIFEST.jsonl"
    rng = np.random.default_rng(0)
    with manifest_path.open("w") as mf:
        for i in range(n_clips):
            cqt = rng.standard_normal((frames_per_clip, CQT_N_BINS)).astype(np.float32)
            # ~85% chord frames (0..59), 15% N frames (60).
            labels = rng.integers(0, 60, size=frames_per_clip).astype(np.int64)
            # Sprinkle some N frames so the loss masks them properly.
            n_idx = rng.choice(frames_per_clip, size=max(1, frames_per_clip // 7), replace=False)
            labels[n_idx] = 60
            cqt_path = root / f"clip_{i:03d}.cqt.npy"
            lbl_path = root / f"clip_{i:03d}.labels.npy"
            np.save(cqt_path, cqt)
            np.save(lbl_path, labels)
            score = f"synthetic-score-{i:03d}"
            score_sha = hashlib.sha256(score.encode()).hexdigest()[:16]
            mf.write(
                json.dumps(
                    {
                        "cqt_npy": str(cqt_path),
                        "labels_npy": str(lbl_path),
                        "score_file": score,
                        "score_sha": score_sha,
                        "source": "synthetic-smoke",
                        "duration_sec": 1.0,
                    }
                )
                + "\n"
            )


def test_train_3_step_smoke(tmp_path: Path) -> None:
    """3-step smoke — must not crash and must write a checkpoint + log."""
    random.seed(0)
    torch.manual_seed(0)

    data_dir = tmp_path / "data"
    out = tmp_path / "run"
    _write_synthetic_dataset(data_dir, n_clips=12, frames_per_clip=32)

    best_ckpt = train(
        data_dir=data_dir,
        out=out,
        epochs=1,
        batch_size=2,
        lr=1e-3,
        seed=0,
        output_mode="structured",
        augment_pitch_shift=False,
        wandb_off=True,
        max_steps_per_epoch=3,
        num_workers=0,
        device=torch.device("cpu"),
        gpu_profile="cpu",
    )

    # Checkpoint exists.
    assert best_ckpt.exists(), f"Expected best checkpoint at {best_ckpt}"
    # Per-epoch checkpoint also exists.
    assert (out / "epoch-001.pt").exists()
    # Log contains run_start + epoch + run_end events.
    log_lines = (out / "train_log.jsonl").read_text().strip().splitlines()
    events = [json.loads(line)["event"] for line in log_lines]
    assert "run_start" in events
    assert "epoch" in events
    assert "run_end" in events


def test_checkpoint_save_and_reload_is_identical(tmp_path: Path) -> None:
    """A saved checkpoint, reloaded, produces identical forward output on fixed input."""
    torch.manual_seed(42)
    model_a = ChordNet2E1D(output_mode="structured")

    ckpt_path = tmp_path / "chk.pt"
    torch.save(
        {
            "model_state": model_a.state_dict(),
            "output_mode": "structured",
            "epoch": 1,
        },
        ckpt_path,
    )
    model_b = ChordNet2E1D(output_mode="structured")
    ckpt = torch.load(ckpt_path, map_location="cpu")
    model_b.load_state_dict(ckpt["model_state"])

    # Deterministic forward pass must match bit-for-bit.
    model_a.eval()
    model_b.eval()
    x = torch.randn(2, 16, CQT_N_BINS, generator=torch.Generator().manual_seed(7))
    with torch.no_grad():
        out_a = model_a(x)
        out_b = model_b(x)
    for key in out_a:
        assert torch.allclose(out_a[key], out_b[key], atol=0, rtol=0), f"head {key} drifted"


# ---------------------------------------------------------------------------
# Factored mode (v1.5 default) — 3-step smoke + loss components
# ---------------------------------------------------------------------------


def test_train_3_step_smoke_factored(tmp_path: Path) -> None:
    """3-step smoke on the v1.5 default (factored) must converge."""
    random.seed(0)
    torch.manual_seed(0)

    data_dir = tmp_path / "data"
    out = tmp_path / "run"
    _write_synthetic_dataset(data_dir, n_clips=12, frames_per_clip=32)

    best_ckpt = train(
        data_dir=data_dir,
        out=out,
        epochs=1,
        batch_size=2,
        lr=1e-3,
        seed=0,
        output_mode="factored",
        augment_pitch_shift=False,
        wandb_off=True,
        max_steps_per_epoch=3,
        num_workers=0,
        device=torch.device("cpu"),
        gpu_profile="cpu",
    )

    assert best_ckpt.exists()
    log_lines = (out / "train_log.jsonl").read_text().strip().splitlines()
    events = [json.loads(line) for line in log_lines]
    assert any(e["event"] == "run_start" for e in events)
    epoch_events = [e for e in events if e["event"] == "epoch"]
    assert epoch_events
    # Factored epoch log includes the val_bass field for schema parity.
    assert "val_bass" in epoch_events[0]


def test_factored_loss_returns_three_components_plus_total() -> None:
    """compute_loss_components returns {root, quality, bass, total} and total == sum."""
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="factored")
    x = torch.randn(2, 16, CQT_N_BINS)
    # Flat 62-class labels (the lossy lift path).
    labels = torch.randint(0, 60, (2, 16))
    lengths = torch.tensor([16, 12])
    logits = model(x)
    weights = {
        "root": torch.ones(NUM_ROOTS + 1),
        "quality": torch.ones(N_QUALITY),
        "bass": torch.ones(N_BASS),
    }
    comps = compute_loss_components(logits, labels, lengths, weights)
    assert set(comps.keys()) == {"root", "quality", "bass", "total"}
    for k in ("root", "quality", "bass"):
        assert comps[k].item() > 0  # positive CE
    assert comps["total"].item() == pytest.approx(
        comps["root"].item() + comps["quality"].item() + comps["bass"].item(),
        rel=1e-5,
    )


def test_factored_loss_accepts_both_label_shapes() -> None:
    """Loss works on (B, T) flat labels AND (B, T, 3) factored labels."""
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="factored")
    x = torch.randn(2, 16, CQT_N_BINS)
    lengths = torch.tensor([16, 16])
    weights = {
        "root": torch.ones(NUM_ROOTS + 1),
        "quality": torch.ones(N_QUALITY),
        "bass": torch.ones(N_BASS),
    }
    logits = model(x)

    flat_labels = torch.randint(0, 60, (2, 16))
    loss_flat = compute_loss(logits, flat_labels, lengths, weights, "factored")

    fact_labels = torch.stack(
        [
            torch.randint(0, NUM_ROOTS + 1, (2, 16)),
            torch.randint(0, N_QUALITY, (2, 16)),
            torch.randint(0, N_BASS, (2, 16)),
        ],
        dim=-1,
    )
    loss_fact = compute_loss(logits, fact_labels, lengths, weights, "factored")
    assert torch.isfinite(loss_flat)
    assert torch.isfinite(loss_fact)


def test_factored_loss_type_check_rejects_flat_weights() -> None:
    """compute_loss(factored) must reject a flat tensor as class_weights."""
    model = ChordNet2E1D(output_mode="factored")
    x = torch.randn(1, 8, CQT_N_BINS)
    labels = torch.zeros(1, 8, dtype=torch.long)
    lengths = torch.tensor([8])
    logits = model(x)
    with pytest.raises(TypeError, match="dict"):
        compute_loss(logits, labels, lengths, torch.ones(62), "factored")


def test_structured_loss_type_check_rejects_dict_weights() -> None:
    """compute_loss(structured) must reject a dict as class_weights."""
    model = ChordNet2E1D(output_mode="structured")
    x = torch.randn(1, 8, CQT_N_BINS)
    labels = torch.zeros(1, 8, dtype=torch.long)
    lengths = torch.tensor([8])
    logits = model(x)
    with pytest.raises(TypeError, match="tensor"):
        compute_loss(logits, labels, lengths, {"root": torch.ones(13)}, "structured")


def test_compute_factored_class_weights_shapes() -> None:
    """compute_factored_class_weights returns three correctly-sized tensors."""
    # Build an in-memory list of manifest-like rows pointing at npys on disk.
    import tempfile

    from training.train import ManifestRow

    with tempfile.TemporaryDirectory() as td:
        rows: list[ManifestRow] = []
        for i in range(3):
            labels = np.random.randint(0, 62, size=16, dtype=np.int64)
            path = Path(td) / f"{i}.npy"
            np.save(path, labels)
            rows.append(
                ManifestRow(
                    cqt_npy=path,
                    labels_npy=path,
                    score_file=f"s{i}",
                    score_sha=f"sha{i}",
                    source="smoke",
                    duration_sec=1.0,
                )
            )
        weights = compute_factored_class_weights(rows)
    assert set(weights) == {"root", "quality", "bass"}
    assert weights["root"].shape == (NUM_ROOTS + 1,)
    assert weights["quality"].shape == (N_QUALITY,)
    assert weights["bass"].shape == (N_BASS,)
    # All weights are finite and non-negative.
    for v in weights.values():
        assert torch.isfinite(v).all()
        assert (v >= 0).all()


def test_compute_class_weights_still_flat_for_legacy() -> None:
    """The flat 62-class weighter is untouched for structured/flat170."""
    import tempfile

    from training.train import ManifestRow

    with tempfile.TemporaryDirectory() as td:
        labels = np.random.randint(0, 62, size=32, dtype=np.int64)
        path = Path(td) / "a.npy"
        np.save(path, labels)
        row = ManifestRow(
            cqt_npy=path,
            labels_npy=path,
            score_file="x",
            score_sha="x",
            source="smoke",
            duration_sec=1.0,
        )
        w = compute_class_weights([row])
    assert w.shape == (62,)
