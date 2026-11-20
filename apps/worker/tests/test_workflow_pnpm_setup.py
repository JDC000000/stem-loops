"""QA-60: no workflow gives pnpm/action-setup a version while package.json pins one.

`pnpm/action-setup` refuses to run with both ("Multiple versions of pnpm specified ...
ERR_PNPM_BAD_PM_VERSION"), which is how deploy.yml's `web` target failed while every job in
ci.yml (no `version:`) passed. Parses the workflow YAML; no network, no database.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[3]
WORKFLOWS = sorted((REPO / ".github" / "workflows").glob("*.yml"))


def _pnpm_setup_steps(path: Path):
    doc = yaml.safe_load(path.read_text())
    for job_name, job in (doc.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            if str(step.get("uses", "")).startswith("pnpm/action-setup"):
                yield job_name, step


def test_package_json_pins_pnpm():
    pm = json.loads((REPO / "package.json").read_text()).get("packageManager", "")
    assert pm.startswith("pnpm@"), "this test assumes packageManager is the single pin"


def test_deploy_workflow_sets_up_pnpm():
    assert list(_pnpm_setup_steps(REPO / ".github" / "workflows" / "deploy.yml"))


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_no_second_pnpm_version(path):
    for job_name, step in _pnpm_setup_steps(path):
        assert "version" not in (step.get("with") or {}), (
            f"{path.name}:{job_name} passes a pnpm version to pnpm/action-setup; "
            "package.json packageManager already pins it"
        )
