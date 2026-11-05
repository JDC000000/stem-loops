"""Smoke-test preemption.py — syntax + public surface only.

Full behavioural coverage (actual torch save/load, SIGTERM round-trip)
belongs in the parallel train.py PR where torch will be an installed test
dep. Here we just verify the module imports standalone and exposes the
public symbols the parallel agent's train.py is expected to import.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

TRAINING_DIR = Path(__file__).resolve().parent.parent
PREEMPTION_PATH = TRAINING_DIR / "preemption.py"


def test_preemption_file_exists() -> None:
    assert PREEMPTION_PATH.exists()


def test_preemption_is_syntactically_valid() -> None:
    ast.parse(
        PREEMPTION_PATH.read_text(encoding="utf-8"), filename=str(PREEMPTION_PATH)
    )


def test_preemption_imports_without_torch() -> None:
    """Import must succeed even if torch is not installed.

    `torch` is imported lazily inside the save / load methods so the module
    itself has no hard torch dependency. This matters: `modal_app.py`
    imports `preemption` at image-build time, and we want import-time to
    stay cheap and torch-free.
    """
    sys.path.insert(0, str(TRAINING_DIR))
    try:
        if "preemption" in sys.modules:
            del sys.modules["preemption"]
        import preemption
    finally:
        sys.path.remove(str(TRAINING_DIR))

    assert hasattr(preemption, "CheckpointManager")
    assert hasattr(preemption, "install_sigterm_handler")
    assert preemption.DEFAULT_INTERVAL_SEC == 300


def test_checkpoint_manager_creates_dir(tmp_path) -> None:
    sys.path.insert(0, str(TRAINING_DIR))
    try:
        import preemption
    finally:
        sys.path.remove(str(TRAINING_DIR))

    target = tmp_path / "ckpts_that_do_not_exist_yet"
    cm = preemption.CheckpointManager(ckpt_dir=target, interval_sec=10)
    assert target.exists(), "CheckpointManager must create its dir"
    assert cm.interval_sec == 10


def test_checkpoint_manager_find_latest_empty(tmp_path) -> None:
    sys.path.insert(0, str(TRAINING_DIR))
    try:
        import preemption
    finally:
        sys.path.remove(str(TRAINING_DIR))

    cm = preemption.CheckpointManager(ckpt_dir=tmp_path)
    assert cm.find_latest() is None, "empty dir → no checkpoint"
