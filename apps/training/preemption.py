"""Preemption-safe checkpointing for Modal L4 training runs.

Why this module exists
----------------------
Modal GPU Functions are preemptible (see `MODAL_BILLING.md` §3 — Modal docs
2026-11-04: *"The `nonpreemptible` parameter is not supported for GPU
Functions."*). Modal will *"gracefully terminate the Function and restart it
on the same input"*, which means `train.py main()` can be killed at any
moment and re-entered from `epoch=0` unless we persist enough state to
resume.

This module gives the training loop:

- `CheckpointManager.maybe_save(...)`: save every N seconds (default 300 s =
  5 min, per PR spec).
- `CheckpointManager.find_latest(...)`: locate the newest checkpoint on the
  Modal Volume and return the path.
- `CheckpointManager.load_into(...)`: restore model weights, optimizer
  state, RNG seeds, and epoch counter from a checkpoint dict.
- `install_sigterm_handler(cm)`: on `SIGTERM` (Modal's preemption signal),
  snapshot once more and exit cleanly inside the grace period.

Everything is deliberately framework-small — just `torch.save` / `torch.load`
plus Python stdlib. No dependency on the still-in-flight `train.py`.

Expected call pattern inside the parallel agent's `train.py`
-------------------------------------------------------------
    from preemption import CheckpointManager, install_sigterm_handler

    ckpt_dir = Path(os.environ["CHORDNET_CHECKPOINT_DIR"])
    cm = CheckpointManager(ckpt_dir=ckpt_dir, interval_sec=300)

    start_epoch, best_metric = cm.resume(model, optimizer)
    install_sigterm_handler(cm, model, optimizer, lambda: {
        "epoch": current_epoch, "best_metric": best_metric,
    })

    for epoch in range(start_epoch, total_epochs):
        ...train one epoch...
        cm.maybe_save(model, optimizer, extra={
            "epoch": epoch,
            "best_metric": best_metric,
        })
"""

from __future__ import annotations

import logging
import random
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — torch is only required at runtime
    import torch
    from torch.optim import Optimizer

logger = logging.getLogger(__name__)


CHECKPOINT_PREFIX = "chordnet"
CHECKPOINT_EXT = ".pt"
DEFAULT_INTERVAL_SEC = 300  # 5 minutes per PR-Modal-Setup spec


# ---------------------------------------------------------------------------
# CheckpointManager
# ---------------------------------------------------------------------------


@dataclass
class CheckpointManager:
    """Writes periodic resumable checkpoints and finds the latest on resume.

    Parameters
    ----------
    ckpt_dir:
        Directory on the Modal Volume (typically `/data/checkpoints`). Created
        if missing.
    interval_sec:
        Minimum seconds between saves. Default 300 (5 min).
    keep_last:
        How many recent checkpoints to retain. Older ones are deleted after a
        successful save. Default 3.
    """

    ckpt_dir: Path
    interval_sec: int = DEFAULT_INTERVAL_SEC
    keep_last: int = 3
    _last_save_t: float = field(default=0.0, init=False, repr=False)

    def __post_init__(self) -> None:
        self.ckpt_dir = Path(self.ckpt_dir)
        self.ckpt_dir.mkdir(parents=True, exist_ok=True)

    # ------- save path ------------------------------------------------------

    def maybe_save(
        self,
        model: torch.nn.Module,
        optimizer: Optimizer,
        extra: dict[str, Any] | None = None,
    ) -> Path | None:
        """Save a checkpoint if `interval_sec` has elapsed since last save.

        Returns the path written, or `None` if nothing was written.
        """
        now = time.monotonic()
        if now - self._last_save_t < self.interval_sec:
            return None
        path = self._save_now(model, optimizer, extra)
        self._last_save_t = now
        return path

    def force_save(
        self,
        model: torch.nn.Module,
        optimizer: Optimizer,
        extra: dict[str, Any] | None = None,
    ) -> Path:
        """Save a checkpoint right now (used from the SIGTERM handler)."""
        path = self._save_now(model, optimizer, extra)
        self._last_save_t = time.monotonic()
        return path

    def _save_now(
        self,
        model: torch.nn.Module,
        optimizer: Optimizer,
        extra: dict[str, Any] | None,
    ) -> Path:
        import torch  # local import so the module imports fine without torch

        ts = time.time()
        path = self.ckpt_dir / f"{CHECKPOINT_PREFIX}_{int(ts)}{CHECKPOINT_EXT}"

        # Snapshot RNG state so a resume reproduces the same sampling order.
        rng_state = {
            "python": random.getstate(),
            "torch_cpu": torch.get_rng_state(),
        }
        if torch.cuda.is_available():
            rng_state["torch_cuda"] = torch.cuda.get_rng_state_all()

        payload: dict[str, Any] = {
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "rng_state": rng_state,
            "saved_at": ts,
        }
        if extra:
            payload.update(extra)

        tmp = path.with_suffix(path.suffix + ".tmp")
        torch.save(payload, tmp)
        tmp.replace(path)  # atomic within one filesystem

        logger.info("checkpoint saved to %s", path)
        self._prune_old()
        return path

    def _prune_old(self) -> None:
        files = sorted(
            self.ckpt_dir.glob(f"{CHECKPOINT_PREFIX}_*{CHECKPOINT_EXT}"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for old in files[self.keep_last :]:
            try:
                old.unlink()
            except OSError:
                logger.warning("failed to prune old checkpoint %s", old)

    # ------- resume path ----------------------------------------------------

    def find_latest(self) -> Path | None:
        """Return the most recent checkpoint path, or `None` if none found."""
        candidates = sorted(
            self.ckpt_dir.glob(f"{CHECKPOINT_PREFIX}_*{CHECKPOINT_EXT}"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        return candidates[0] if candidates else None

    def load_into(
        self,
        path: Path,
        model: torch.nn.Module,
        optimizer: Optimizer,
    ) -> dict[str, Any]:
        """Load weights, optimizer state, and RNG state from `path`.

        Returns the `extra` fields the training loop stored (e.g. `epoch`,
        `best_metric`). Model and optimizer are mutated in-place.
        """
        import torch

        payload = torch.load(path, map_location="cpu")

        model.load_state_dict(payload["model"])
        optimizer.load_state_dict(payload["optimizer"])

        rng = payload.get("rng_state", {})
        if "python" in rng:
            random.setstate(rng["python"])
        if "torch_cpu" in rng:
            torch.set_rng_state(rng["torch_cpu"])
        if "torch_cuda" in rng and torch.cuda.is_available():
            torch.cuda.set_rng_state_all(rng["torch_cuda"])

        extras = {
            k: v
            for k, v in payload.items()
            if k not in {"model", "optimizer", "rng_state", "saved_at"}
        }
        logger.info("resumed from %s (extras=%s)", path, list(extras))
        return extras

    def resume(
        self,
        model: torch.nn.Module,
        optimizer: Optimizer,
    ) -> dict[str, Any]:
        """Convenience: find latest + load if present. Returns extras or {}."""
        latest = self.find_latest()
        if latest is None:
            logger.info("no checkpoint in %s; starting from scratch", self.ckpt_dir)
            return {}
        return self.load_into(latest, model, optimizer)


# ---------------------------------------------------------------------------
# SIGTERM handler for Modal's preemption grace period
# ---------------------------------------------------------------------------


def install_sigterm_handler(
    cm: CheckpointManager,
    model: torch.nn.Module,
    optimizer: Optimizer,
    extras_fn: Callable[[], dict[str, Any]] | None = None,
) -> None:
    """Snapshot once more on SIGTERM, then exit 0 so Modal restarts cleanly.

    Modal docs (2026-11-04): *"[Modal] will send an interrupt signal to your
    container when preemption occurs"*. We treat SIGTERM as the preemption
    signal and race one last `force_save` into the grace window before the
    container is killed.
    """

    def _handler(signum: int, _frame: object) -> None:
        logger.warning("SIGTERM received (signum=%d); force-saving checkpoint", signum)
        try:
            extras = extras_fn() if extras_fn else None
            cm.force_save(model, optimizer, extras)
        except Exception as exc:  # pragma: no cover — best-effort
            logger.exception("force_save during SIGTERM failed: %s", exc)
        # Exit 0 so Modal's restart-on-same-input semantics kick in cleanly.
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _handler)
    logger.info("SIGTERM handler installed for preemption-safe checkpointing")


__all__ = [
    "CheckpointManager",
    "install_sigterm_handler",
    "CHECKPOINT_PREFIX",
    "CHECKPOINT_EXT",
    "DEFAULT_INTERVAL_SEC",
]
