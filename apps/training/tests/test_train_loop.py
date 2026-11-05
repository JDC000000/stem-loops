"""Training-loop smoke test — 3 steps on synthetic data, then save+reload.

CPU-only. No network. No dataset download. No GPU.
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

import numpy as np
import torch

from training.model.chordnet_2e1d import CQT_N_BINS, ChordNet2E1D
from training.train import train


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
