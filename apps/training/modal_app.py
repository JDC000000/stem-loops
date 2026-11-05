"""Modal app wrapper for the Y1 chord-model training pipeline.

This is pure infrastructure wiring for PR-Modal-Setup. The training logic
(train.py, eval.py) is being built by a parallel agent. These Modal functions
are thin shims that invoke that code once it lands; today they stand on their
own enough to pass a syntax-level smoke test and to `modal deploy` without
errors.

Usage
-----
    # One-command run (via bash wrapper):
    ./scripts/modal_train.sh --gpu l4 --epochs 30 --seed 42

    # Direct:
    modal run apps/training/modal_app.py::train_chordnet \
        --config-path configs/chordnet_2e1d_v1.yaml \
        --epochs 30

Billing & preemption notes: see `apps/training/MODAL_BILLING.md`.
Volume strategy: see `apps/training/MODAL_SETUP.md`.
Checkpointing on preemption: see `apps/training/preemption.py`.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import modal

# ---------------------------------------------------------------------------
# App + image definition
# ---------------------------------------------------------------------------

APP_NAME = "stem-loops-chordnet"
VOLUME_NAME = "chordnet-data"

# Pinned package versions mirror apps/training/pyproject.toml. Keep them in
# sync — Modal builds the image from this list, not from pyproject.
_PIP_PACKAGES = [
    "torch>=2.1",
    "torchaudio",
    "librosa",
    "mir_eval>=0.7",
    "pyFluidSynth",
    "music21>=9.1",
    "numpy>=1.26",
    "scipy>=1.13",
    "pyyaml>=6.0",
]

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("fluidsynth", "libsndfile1", "ffmpeg")
    .pip_install(*_PIP_PACKAGES)
    .add_local_dir("./apps/training", "/root/training")
)

app = modal.App(APP_NAME)

# One shared volume for synthetic + real corpora and checkpoints. The `create
# _if_missing=True` flag means a fresh account spins this up on first run
# with no `modal volume create` step.
data_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

# ---------------------------------------------------------------------------
# GPU profile presets
# ---------------------------------------------------------------------------
#
# Modal pricing page (fetched 2026-11-04):
#   L4       $0.000222 /s = $0.80/h
#   A10      $0.000306 /s = $1.10/h
#   A100-40  $0.000583 /s = $2.10/h
#
# Week-3 default per decision record v1.3: L4. Escalate to A10 / A100-40 only
# if the loss curve justifies it.

GPU_PROFILES = {
    "l4": "L4",
    "a10": "A10",
    "a100-40": "A100-40GB",
    "a100-80": "A100-80GB",
}


# ---------------------------------------------------------------------------
# train_chordnet
# ---------------------------------------------------------------------------


@app.function(
    image=image,
    gpu="L4",
    timeout=14400,  # 4 h hard cap — one run should finish in 1-4
    memory=16384,  # 16 GiB
    volumes={"/data": data_volume},
)
def train_chordnet(
    config_path: str = "configs/chordnet_2e1d_v1.yaml",
    epochs: int = 30,
    seed: int = 42,
) -> dict:
    """Run one training pass of the Y1 chord model on the configured GPU.

    Shells out to `apps/training/train.py main()` (built by the parallel
    training-agent PR). Checkpoints and metrics land under `/data/` on the
    shared volume; `modal volume get` pulls them locally.

    Returns a dict with the final metrics so a caller running
    `modal run ...` sees the result inline.
    """

    # The training module is mounted under /root/training by `add_local_dir`.
    training_dir = Path("/root/training")
    train_entry = training_dir / "train.py"

    if not train_entry.exists():
        # train.py has not landed yet — surface a clear error instead of
        # pretending we ran.
        return {
            "status": "not_implemented",
            "reason": "apps/training/train.py not present in image",
            "config_path": config_path,
            "epochs": epochs,
            "seed": seed,
        }

    # Volume paths — training script reads corpus from /data/cache and writes
    # checkpoints to /data/checkpoints.
    env = {
        **os.environ,
        "CHORDNET_DATA_ROOT": "/data",
        "CHORDNET_CHECKPOINT_DIR": "/data/checkpoints",
        "CHORDNET_CONFIG": str(training_dir / config_path),
        "CHORDNET_EPOCHS": str(epochs),
        "CHORDNET_SEED": str(seed),
        "PYTHONPATH": str(training_dir),
    }

    result = subprocess.run(
        [sys.executable, str(train_entry)],
        env=env,
        cwd=str(training_dir),
        check=False,
        capture_output=True,
        text=True,
    )

    # Commit volume writes so later eval_chordnet calls see the checkpoint.
    data_volume.commit()

    return {
        "status": "ok" if result.returncode == 0 else "failed",
        "returncode": result.returncode,
        "stdout_tail": result.stdout[-4000:] if result.stdout else "",
        "stderr_tail": result.stderr[-4000:] if result.stderr else "",
        "config_path": config_path,
        "epochs": epochs,
        "seed": seed,
    }


# ---------------------------------------------------------------------------
# eval_chordnet
# ---------------------------------------------------------------------------


@app.function(
    image=image,
    cpu=4.0,
    memory=8192,  # 8 GiB
    volumes={"/data": data_volume},
)
def eval_chordnet(checkpoint_name: str) -> dict:
    """Evaluate a saved checkpoint on the held-out eval set (CPU-only).

    Checkpoint must exist on the shared volume under
    `/data/checkpoints/<checkpoint_name>`. Writes an `eval_<ts>.json` sibling.
    """

    training_dir = Path("/root/training")
    eval_entry = training_dir / "eval.py"

    # Refresh the volume handle so we see files the latest training run wrote.
    data_volume.reload()

    ckpt_path = Path("/data/checkpoints") / checkpoint_name
    if not ckpt_path.exists():
        return {
            "status": "not_found",
            "reason": f"checkpoint missing at {ckpt_path}",
            "checkpoint_name": checkpoint_name,
        }

    if not eval_entry.exists():
        return {
            "status": "not_implemented",
            "reason": "apps/training/eval.py not present in image",
            "checkpoint_name": checkpoint_name,
        }

    result = subprocess.run(
        [sys.executable, str(eval_entry), "--checkpoint", str(ckpt_path)],
        cwd=str(training_dir),
        check=False,
        capture_output=True,
        text=True,
    )

    data_volume.commit()

    return {
        "status": "ok" if result.returncode == 0 else "failed",
        "returncode": result.returncode,
        "checkpoint_name": checkpoint_name,
        "stdout_tail": result.stdout[-4000:] if result.stdout else "",
        "stderr_tail": result.stderr[-4000:] if result.stderr else "",
    }


# ---------------------------------------------------------------------------
# Local entrypoint for `modal run`
# ---------------------------------------------------------------------------


@app.local_entrypoint()
def main(
    config_path: str = "configs/chordnet_2e1d_v1.yaml",
    epochs: int = 30,
    seed: int = 42,
) -> None:
    """`modal run apps/training/modal_app.py` enters here."""
    out = train_chordnet.remote(
        config_path=config_path,
        epochs=epochs,
        seed=seed,
    )
    print(out)
