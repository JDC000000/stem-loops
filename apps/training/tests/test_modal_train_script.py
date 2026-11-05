"""Static checks on ``scripts/modal_train.sh``.

The shell script is dispatched from a Modal wrapper that cannot be exercised
in CI (no ``modal`` CLI, no auth). We cover its flag parsing and mode-routing
behaviour by (a) grepping the script body for the required tokens and (b)
driving it with ``bash -n`` for syntax and a local stub-mode subprocess that
short-circuits before the ``modal run`` exec.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT = _REPO_ROOT / "scripts" / "modal_train.sh"
_FULL_CONFIG = _REPO_ROOT / "apps" / "training" / "configs" / "chordnet_2e1d_v1.yaml"
_SMOKE_CONFIG = _REPO_ROOT / "apps" / "training" / "configs" / "chordnet_2e1d_v1_smoke100.yaml"


def test_script_exists_and_is_file() -> None:
    assert _SCRIPT.exists(), f"missing script at {_SCRIPT}"
    assert _SCRIPT.is_file()


def test_script_has_bash_shebang() -> None:
    first_line = _SCRIPT.read_text().splitlines()[0]
    assert first_line.startswith("#!"), first_line
    assert "bash" in first_line


# ---------------------------------------------------------------------------
# Help / flag surface — grep on the script body.
# ---------------------------------------------------------------------------


def test_help_block_documents_smoke_flag() -> None:
    body = _SCRIPT.read_text()
    # Help text is the leading comment block before `set -euo`.
    head, _, _ = body.partition("set -euo")
    assert "--smoke" in head, "--smoke flag must appear in the help header"
    # Every documented flag in the header stays in sync with the parser below.
    for flag in ("--gpu", "--epochs", "--seed", "--config", "--smoke"):
        assert flag in head, f"help header missing {flag}"


def test_parser_routes_smoke_to_smoke_config() -> None:
    body = _SCRIPT.read_text()
    # The smoke branch must set CONFIG to the smoke-config filename.
    assert "chordnet_2e1d_v1_smoke100.yaml" in body
    # Guard the clause structure — a `--smoke)` case must exist in the while loop.
    assert "--smoke)" in body


def test_parser_has_epochs_override() -> None:
    body = _SCRIPT.read_text()
    assert "--epochs)" in body
    # Variable must be assigned somewhere in the parser body.
    assert "EPOCHS=" in body


# ---------------------------------------------------------------------------
# Config files that --smoke / default point to must exist.
# ---------------------------------------------------------------------------


def test_default_config_file_exists() -> None:
    assert _FULL_CONFIG.exists(), f"missing default config at {_FULL_CONFIG}"


def test_smoke_config_file_exists() -> None:
    assert _SMOKE_CONFIG.exists(), f"missing smoke config at {_SMOKE_CONFIG}"


# ---------------------------------------------------------------------------
# bash -n syntax check (no execution of modal).
# ---------------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not on PATH")
def test_bash_syntax_is_valid() -> None:
    result = subprocess.run(
        ["bash", "-n", str(_SCRIPT)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"bash -n failed: {result.stderr}"


# ---------------------------------------------------------------------------
# Help flag short-circuits (exit 0) before requiring `modal`.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not on PATH")
def test_help_flag_returns_zero() -> None:
    result = subprocess.run(
        ["bash", str(_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        env={**os.environ},
    )
    assert result.returncode == 0, result.stderr
    out = result.stdout
    # Usage block should surface the key flags.
    assert "--smoke" in out
    assert "--gpu" in out
