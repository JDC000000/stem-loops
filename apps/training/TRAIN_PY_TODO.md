# Hand-off notes for the parallel train.py agent

PR-Modal-Setup lands the Modal wrapper + billing doc + preemption module
for the Y1 chord-model training. The actual `train.py` + `eval.py` are
being built in a separate PR. This file is the contract between the two.

## 1. Import `preemption` and call it on entry

`apps/training/train.py` should start like:

```python
import os
from pathlib import Path

from preemption import CheckpointManager, install_sigterm_handler

def main() -> None:
    ckpt_dir = Path(os.environ.get("CHORDNET_CHECKPOINT_DIR", "/data/checkpoints"))
    cm = CheckpointManager(ckpt_dir=ckpt_dir, interval_sec=300)

    # ...build model, optimizer, data loaders, read config...
    # model, optimizer = build(...)

    # Resume from latest checkpoint if present.
    extras = cm.resume(model, optimizer)
    start_epoch = extras.get("epoch", 0)
    best_metric = extras.get("best_metric")

    # One-time: install SIGTERM handler so Modal preemption saves cleanly.
    install_sigterm_handler(
        cm, model, optimizer,
        extras_fn=lambda: {"epoch": current_epoch, "best_metric": best_metric},
    )

    for current_epoch in range(start_epoch, int(os.environ.get("CHORDNET_EPOCHS", 30))):
        # ... one training epoch ...
        cm.maybe_save(model, optimizer, extra={
            "epoch": current_epoch,
            "best_metric": best_metric,
        })
```

## 2. Environment variables set by `modal_app.py`

| Var | Meaning | Default |
|-----|---------|---------|
| `CHORDNET_DATA_ROOT` | Root of the Modal Volume mount | `/data` |
| `CHORDNET_CHECKPOINT_DIR` | Where to save checkpoints | `/data/checkpoints` |
| `CHORDNET_CONFIG` | Absolute path to the YAML config | (set by wrapper) |
| `CHORDNET_EPOCHS` | Training epochs (int, string-encoded) | `30` |
| `CHORDNET_SEED` | RNG seed (int, string-encoded) | `42` |
| `PYTHONPATH` | Includes `/root/training` | (set by wrapper) |

## 3. Seed the RNG from `CHORDNET_SEED` on entry

`preemption.py` snapshots RNG state so a resume reproduces sampling order,
but the very first run needs deterministic seeding. In `train.py`'s main:

```python
import random, numpy as np, torch
seed = int(os.environ.get("CHORDNET_SEED", "42"))
random.seed(seed)
np.random.seed(seed)
torch.manual_seed(seed)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(seed)
```

## 4. Write the "best" checkpoint under a fixed name

The bash workflow pulls `/checkpoints/best.pt`:

```bash
modal volume get chordnet-data /checkpoints/best.pt ./local/
```

So when the eval metric improves, copy the latest rolling checkpoint to
`best.pt`:

```python
import shutil
if is_best:
    shutil.copyfile(latest_ckpt_path, cm.ckpt_dir / "best.pt")
```

## 5. Exit non-zero on failure

`modal_app.py::train_chordnet` reports `status="failed"` when the
subprocess returns non-zero. Make `train.py` call `sys.exit(1)` on any
unrecoverable error so the Modal function result reflects it.

## 6. Eval script shape

`apps/training/eval.py` is called by `modal_app.py::eval_chordnet` as:

```
python eval.py --checkpoint /data/checkpoints/<name>.pt
```

It should write `/data/eval/eval_<ts>.json` and print the metrics dict to
stdout (modal_app captures stdout/stderr tails).
