"""Smoke-test the Modal app wiring without executing any remote run.

This test imports `apps/training/modal_app.py` and verifies that the
decorators were applied to the expected function names with the expected
knobs. It does NOT authenticate against Modal, does NOT spin up a GPU, and
does NOT touch the network.

Covers PR-Modal-Setup rule: *"smoke test `apps/training/tests/
test_modal_app.py` that imports `modal_app.py` without executing (just check
syntax + decorator wiring)"*.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

# apps/training/ is this test file's grandparent.
TRAINING_DIR = Path(__file__).resolve().parent.parent
MODAL_APP_PATH = TRAINING_DIR / "modal_app.py"


def _can_import_modal() -> bool:
    try:
        __import__("modal")
        return True
    except ImportError:
        return False


_MODAL_AVAILABLE = _can_import_modal()


def test_modal_app_file_exists() -> None:
    assert MODAL_APP_PATH.exists(), f"missing {MODAL_APP_PATH}"


def test_modal_app_is_syntactically_valid() -> None:
    """Parse modal_app.py; fails loud on any SyntaxError."""
    source = MODAL_APP_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MODAL_APP_PATH))
    assert isinstance(tree, ast.Module)


def _top_level_functions(tree: ast.Module) -> dict[str, ast.FunctionDef]:
    return {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}


def _decorator_callee(dec: ast.expr) -> str:
    """Return the callee name / dotted path for a decorator expression."""
    target = dec.func if isinstance(dec, ast.Call) else dec
    if isinstance(target, ast.Attribute):
        parts: list[str] = []
        cur: ast.expr = target
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        return ".".join(reversed(parts))
    if isinstance(target, ast.Name):
        return target.id
    return "<unknown>"


def _decorator_kwargs(dec: ast.expr) -> dict[str, ast.expr]:
    if not isinstance(dec, ast.Call):
        return {}
    return {kw.arg: kw.value for kw in dec.keywords if kw.arg is not None}


def test_train_chordnet_decorator_wiring() -> None:
    """`train_chordnet` is an @app.function with gpu / timeout / memory / volumes."""
    tree = ast.parse(MODAL_APP_PATH.read_text(encoding="utf-8"))
    fns = _top_level_functions(tree)
    assert "train_chordnet" in fns, "train_chordnet function missing"

    fn = fns["train_chordnet"]
    assert fn.decorator_list, "train_chordnet has no decorators"

    # First decorator must be `app.function(...)` with the GPU knobs.
    dec = fn.decorator_list[0]
    callee = _decorator_callee(dec)
    assert callee.endswith("app.function"), f"expected @app.function, got {callee!r}"

    kwargs = _decorator_kwargs(dec)
    for required in ("image", "gpu", "timeout", "memory", "volumes"):
        assert required in kwargs, f"train_chordnet missing kwarg {required!r}"

    # gpu kwarg should be a string literal naming a supported GPU.
    gpu_node = kwargs["gpu"]
    assert isinstance(gpu_node, ast.Constant) and isinstance(
        gpu_node.value, str
    ), "gpu kwarg must be a string literal"
    assert gpu_node.value in {"L4", "A10", "A100-40GB", "A100-80GB"}

    # timeout ≥ 1 h — Week-3 runs are expected to take 1-4 h.
    timeout_node = kwargs["timeout"]
    assert isinstance(timeout_node, ast.Constant), "timeout must be a literal"
    assert timeout_node.value >= 3600


def test_eval_chordnet_decorator_wiring() -> None:
    """`eval_chordnet` is an @app.function (CPU-only, reads the same volume)."""
    tree = ast.parse(MODAL_APP_PATH.read_text(encoding="utf-8"))
    fns = _top_level_functions(tree)
    assert "eval_chordnet" in fns, "eval_chordnet function missing"

    fn = fns["eval_chordnet"]
    assert fn.decorator_list
    dec = fn.decorator_list[0]
    assert _decorator_callee(dec).endswith("app.function")

    kwargs = _decorator_kwargs(dec)
    # eval is intentionally CPU-only — no gpu kwarg expected.
    assert "gpu" not in kwargs, "eval_chordnet should not request a GPU"
    assert "volumes" in kwargs, "eval_chordnet must mount the shared volume"


@pytest.mark.skipif(
    not _MODAL_AVAILABLE,
    reason="modal client not installed; skipping runtime import smoke test",
)
def test_modal_app_imports_cleanly() -> None:
    """If the modal client is installed, the module imports without error."""
    sys.path.insert(0, str(TRAINING_DIR))
    try:
        import modal_app  # type: ignore[import-not-found]
    finally:
        sys.path.remove(str(TRAINING_DIR))

    assert hasattr(modal_app, "app"), "modal_app must expose an `app`"
    assert hasattr(modal_app, "train_chordnet")
    assert hasattr(modal_app, "eval_chordnet")
    assert modal_app.APP_NAME == "stem-loops-chordnet"
