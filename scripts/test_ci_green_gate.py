"""Unit tests for scripts/ci_green_gate.py and its wiring in deploy.yml (stdlib unittest).

Run: python -I -u -m unittest discover -v -s scripts -p 'test_ci_green_gate.py'
"""

from __future__ import annotations

import io
import json
import os
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import importlib.util

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("ci_green_gate", HERE / "ci_green_gate.py")
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

DEPLOY_YML = HERE.parent / ".github" / "workflows" / "deploy.yml"

SHA = "f9f92f3" + "a" * 33
OTHER = "b" * 40


def run(name, status="completed", conclusion="success", sha=SHA, app_id=15368, rid=1):
    return {
        "id": rid,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "head_sha": sha,
        "app": {"id": app_id, "slug": "github-actions"},
    }


def all_green(extra=()):
    runs = [run(n, rid=i) for i, n in enumerate(gate.REQUIRED_CONTEXTS)]
    runs.extend(extra)
    return runs


def ndjson(runs):
    return "\n".join(json.dumps(r) for r in runs) + "\n"


def cmp(status="identical", base=SHA):
    return json.dumps({"status": status, "merge_base": base})


class Evaluate(unittest.TestCase):
    def ok(self, runs, compare=None, sha=SHA):
        return gate.evaluate(sha, ndjson(runs), compare if compare is not None else cmp())

    def test_all_green_identical_passes(self):
        self.assertEqual(self.ok(all_green()), [])

    def test_all_green_ancestor_of_main_passes(self):
        self.assertEqual(self.ok(all_green(), cmp("ahead")), [])

    def test_ruleset_has_exactly_ten_contexts(self):
        self.assertEqual(len(gate.REQUIRED_CONTEXTS), 10)
        self.assertEqual(len(set(gate.REQUIRED_CONTEXTS)), 10)

    def test_deploy_job_names_disjoint_from_required(self):
        self.assertFalse(set(gate.REQUIRED_CONTEXTS) & gate.DEPLOY_WORKFLOW_JOB_NAMES)

    def test_each_missing_context_fails(self):
        for ctx in gate.REQUIRED_CONTEXTS:
            with self.subTest(ctx=ctx):
                runs = [r for r in all_green() if r["name"] != ctx]
                probs = self.ok(runs)
                self.assertEqual(len(probs), 1, probs)
                self.assertIn(ctx, probs[0])

    def test_non_success_states_fail(self):
        bad = [
            ("in_progress", None),
            ("queued", None),
            ("pending", None),
            ("completed", "skipped"),
            ("completed", "neutral"),
            ("completed", "failure"),
            ("completed", "cancelled"),
            ("completed", "timed_out"),
            ("completed", "action_required"),
            ("completed", "stale"),
            ("completed", None),
            (None, "success"),
        ]
        for status, concl in bad:
            with self.subTest(status=status, conclusion=concl):
                runs = all_green()
                runs[6] = run(runs[6]["name"], status=status, conclusion=concl)
                probs = self.ok(runs)
                self.assertEqual(len(probs), 1, probs)

    def test_incident_shape_browser_journeys_in_progress_fails(self):
        # The S21 #420 shape: every check green but one still running.
        runs = all_green()
        runs = [r for r in runs if r["name"] != "Browser journeys (real Chromium)"]
        runs.append(run("Browser journeys (real Chromium)", status="in_progress", conclusion=None))
        self.assertTrue(self.ok(runs))

    def test_duplicate_context_one_red_fails(self):
        runs = all_green([run("Tests", conclusion="failure", rid=99)])
        probs = self.ok(runs)
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("Tests", probs[0])

    def test_other_app_same_name_cannot_satisfy(self):
        runs = [r for r in all_green() if r["name"] != "Lint"]
        runs.append(run("Lint", app_id=12345))
        self.assertTrue(self.ok(runs))

    def test_other_app_same_name_red_is_ignored(self):
        self.assertEqual(self.ok(all_green([run("Lint", conclusion="failure", app_id=1)])), [])

    def test_missing_app_cannot_satisfy(self):
        runs = [r for r in all_green() if r["name"] != "Lint"]
        r = run("Lint")
        del r["app"]
        runs.append(r)
        self.assertTrue(self.ok(runs))

    def test_wrong_head_sha_fails(self):
        runs = [r for r in all_green() if r["name"] != "Web build"]
        runs.append(run("Web build", sha=OTHER))
        self.assertTrue(self.ok(runs))

    def test_non_required_red_runs_are_ignored(self):
        extra = [
            run("Training tests (pytest, CPU torch)", conclusion="failure"),
            run("TSD §N.M refs resolve (Fleet Playbook Move 4)", conclusion="skipped"),
        ]
        self.assertEqual(self.ok(all_green(extra)), [])

    def test_deploy_workflow_own_runs_ignored(self):
        extra = [
            run("CI green gate (deployed SHA on v3/main)", status="in_progress", conclusion=None),
            run("Deploy Worker to Fly.io", status="queued", conclusion=None),
            run("Deploy Web to Vercel", status="completed", conclusion="skipped"),
        ]
        self.assertEqual(self.ok(all_green(extra)), [])

    def test_no_runs_fails_for_all_ten(self):
        self.assertEqual(len(self.ok([])), 10)

    def test_not_on_main_statuses_fail(self):
        for status in ("behind", "diverged", None, "", "IDENTICAL"):
            with self.subTest(status=status):
                self.assertTrue(self.ok(all_green(), cmp(status)))

    def test_merge_base_must_be_sha(self):
        self.assertTrue(self.ok(all_green(), cmp("ahead", OTHER)))
        self.assertTrue(self.ok(all_green(), cmp("ahead", None)))

    def test_compare_garbage_fails(self):
        for text in ("", "not json", "[]", "null", '"identical"'):
            with self.subTest(text=text):
                self.assertTrue(self.ok(all_green(), text))

    def test_runs_garbage_fails(self):
        for text in ("{not json", "[1, 2]", '{"check_runs": 5}'):
            with self.subTest(text=text):
                self.assertTrue(gate.evaluate(SHA, text, cmp()))

    def test_runs_array_and_envelope_forms(self):
        runs = all_green()
        self.assertEqual(gate.evaluate(SHA, json.dumps(runs), cmp()), [])
        self.assertEqual(gate.evaluate(SHA, json.dumps({"check_runs": runs}), cmp()), [])

    def test_bad_sha_fails(self):
        for sha in ("", "v3/main", SHA[:39], SHA.upper(), SHA + "0", None):
            with self.subTest(sha=sha):
                self.assertTrue(gate.evaluate(sha, ndjson(all_green()), cmp()))


class Main(unittest.TestCase):
    def _main(self, runs_text, compare_text, sha=SHA):
        with tempfile.TemporaryDirectory() as d:
            rp, cp = os.path.join(d, "r.ndjson"), os.path.join(d, "c.json")
            Path(rp).write_text(runs_text, encoding="utf-8")
            Path(cp).write_text(compare_text, encoding="utf-8")
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = gate.main(["--sha", sha, "--runs", rp, "--compare", cp])
            return rc, buf.getvalue()

    def test_main_ok(self):
        rc, out = self._main(ndjson(all_green()), cmp())
        self.assertEqual(rc, 0, out)
        self.assertIn("OK", out)

    def test_main_fail(self):
        rc, out = self._main(ndjson(all_green()[:-1]), cmp())
        self.assertEqual(rc, 1)
        self.assertIn("FAIL", out)

    def test_main_missing_file_fails(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = gate.main(["--sha", SHA, "--runs", "/nonexistent/x", "--compare", "/nonexistent/y"])
        self.assertEqual(rc, 1)


def _jobs_block(text):
    """Split deploy.yml into {job_id: body} (top-level `jobs:` children at 2-space indent)."""
    m = re.search(r"^jobs:\n", text, re.M)
    assert m, "no jobs: key"
    jobs, cur = {}, None
    for line in text[m.end():].splitlines():
        if re.match(r"^\S", line):
            break
        jm = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if jm:
            cur = jm.group(1)
            jobs[cur] = []
        elif cur:
            jobs[cur].append(line)
    return {k: "\n".join(v) for k, v in jobs.items()}


class DeployWorkflowWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = DEPLOY_YML.read_text(encoding="utf-8")
        cls.jobs = _jobs_block(cls.text)

    def test_gate_job_exists_with_least_privilege(self):
        g = self.jobs.get("ci-green-gate")
        self.assertIsNotNone(g, list(self.jobs))
        self.assertIn("name: CI green gate (deployed SHA on v3/main)", g)
        perms = re.search(r"\n    permissions:\n((?:      .*\n?)+)", g)
        self.assertIsNotNone(perms)
        lines = sorted(l.strip() for l in perms.group(1).splitlines() if l.strip())
        self.assertEqual(lines, ["checks: read", "contents: read"])
        self.assertIn("scripts/ci_green_gate.py", g)
        self.assertIn("python3 -I -u", g)

    def test_every_deploy_job_needs_gate_and_has_no_status_override(self):
        deploys = [j for j in self.jobs if j != "ci-green-gate"]
        self.assertGreaterEqual(len(deploys), 2)
        for j in deploys:
            with self.subTest(job=j):
                body = self.jobs[j]
                self.assertRegex(body, r"\n    needs: \[?ci-green-gate\]?\s*\n")
                # always()/failure()/cancelled() in `if:` would run a deploy past a red gate.
                self.assertNotRegex(body, r"always\(\)|failure\(\)|cancelled\(\)|!\s*cancelled")

    def test_no_expressions_inside_gate_run_blocks(self):
        g = self.jobs["ci-green-gate"]
        for m in re.finditer(r"\n        run: \|\n((?:          .*\n?|\s*\n)+)", g):
            self.assertNotIn("${{", m.group(1))

    def test_uses_pinned_to_full_sha(self):
        for m in re.finditer(r"uses:\s*([^\s#]+)", self.text):
            ref = m.group(1)
            if ref.startswith("./"):
                continue
            with self.subTest(uses=ref):
                self.assertRegex(ref, r"@[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
