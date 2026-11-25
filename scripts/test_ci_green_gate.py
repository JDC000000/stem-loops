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


CI_SUITE = 5001
DEPLOY_SUITE = 9001  # this gate's own run
OLD_DEPLOY_SUITE = 9000  # an earlier dispatch of deploy.yml on the same SHA
RUN_ID = 777
OLD_RUN_ID = 776
DEPLOY_PATH = ".github/workflows/deploy.yml"


def run(name, status="completed", conclusion="success", sha=SHA, app_id=15368, rid=1, suite=CI_SUITE):
    return {
        "id": rid,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "head_sha": sha,
        "app": {"id": app_id, "slug": "github-actions"},
        "check_suite": {"id": suite},
    }


def wr(rid=RUN_ID, suite=DEPLOY_SUITE, path=DEPLOY_PATH):
    return {"id": rid, "check_suite_id": suite, "path": path}


DEPLOY_RUNS = [wr(OLD_RUN_ID, OLD_DEPLOY_SUITE), wr()]

# The other (non-required) ci.yml jobs and other workflows seen on v3/main SHAs.
NON_REQUIRED_GREEN = [
    ("Alphabet drift check", "success"),
    ("Python syntax (compileall) + repo-wide merge markers", "success"),
    ("Training tests (pytest, CPU torch)", "success"),
    ("TSD §N.M refs resolve (Fleet Playbook Move 4)", "skipped"),
    ("Credit pack price recon (audit M5)", "success"),
    ("Chord chip fit (real Chromium)", "success"),
    ("Enable auto-merge on rollback-safe + adversarial-reviewed PRs", "skipped"),
]


def all_green(extra=()):
    runs = [run(n, rid=i) for i, n in enumerate(gate.REQUIRED_CONTEXTS)]
    runs.extend(extra)
    return runs


def ndjson(runs):
    return "\n".join(json.dumps(r) for r in runs) + "\n"


def cmp(status="identical", base=SHA):
    return json.dumps({"status": status, "merge_base": base})


class Evaluate(unittest.TestCase):
    def ok(self, runs, compare=None, sha=SHA, deploy_runs=None, run_id=RUN_ID):
        return gate.evaluate(
            sha,
            ndjson(runs),
            compare if compare is not None else cmp(),
            ndjson(DEPLOY_RUNS if deploy_runs is None else deploy_runs),
            run_id,
        )

    def test_all_green_identical_passes(self):
        self.assertEqual(self.ok(all_green()), [])

    def test_all_green_ancestor_of_main_passes(self):
        self.assertEqual(self.ok(all_green(), cmp("ahead")), [])

    def test_ruleset_has_exactly_ten_contexts(self):
        self.assertEqual(len(gate.REQUIRED_CONTEXTS), 10)
        self.assertEqual(len(set(gate.REQUIRED_CONTEXTS)), 10)

    def test_realistic_main_sha_passes(self):
        extra = [run(n, conclusion=c, rid=100 + i) for i, (n, c) in enumerate(NON_REQUIRED_GREEN)]
        self.assertEqual(self.ok(all_green(extra)), [])

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
        runs = all_green([run("Tests", conclusion="failure", rid=99, suite=5002)])
        probs = self.ok(runs)
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("Tests", probs[0])

    def test_duplicate_context_red_first_green_last_fails(self):
        # R1 A-1: order must not matter; every latest-per-name run must pass.
        runs = [r for r in all_green() if r["name"] != "Tests"]
        runs.append(run("Tests", conclusion="failure", rid=98, suite=5002))
        runs.append(run("Tests", rid=99))
        probs = self.ok(runs)
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("Tests", probs[0])

    def test_duplicate_non_required_red_first_green_last_fails(self):
        extra = [
            run("Chord chip fit (real Chromium)", conclusion="failure", rid=60, suite=5002),
            run("Chord chip fit (real Chromium)", rid=61),
        ]
        self.assertTrue(self.ok(all_green(extra)))

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

    def test_fable_case_three_non_required_ci_jobs_red_fails(self):
        # R1 B-1: real f9f92f3 shape with 3 non-required ci.yml jobs failed.
        red = {"Credit pack price recon (audit M5)", "Training tests (pytest, CPU torch)", "Alphabet drift check"}
        extra = [
            run(n, conclusion=("failure" if n in red else c), rid=100 + i)
            for i, (n, c) in enumerate(NON_REQUIRED_GREEN)
        ]
        probs = self.ok(all_green(extra))
        self.assertEqual(len(probs), 3, probs)
        for n in red:
            self.assertTrue(any(n in p for p in probs), (n, probs))

    def test_non_required_states(self):
        for status, concl, passes in [
            ("completed", "success", True),
            ("completed", "skipped", True),
            ("completed", "failure", False),
            ("completed", "neutral", False),
            ("completed", "cancelled", False),
            ("completed", "timed_out", False),
            ("completed", "action_required", False),
            ("completed", "stale", False),
            ("completed", None, False),
            ("in_progress", None, False),
            ("queued", None, False),
            ("waiting", None, False),
        ]:
            with self.subTest(status=status, conclusion=concl):
                probs = self.ok(all_green([run("Chord chip fit (real Chromium)", status=status, conclusion=concl, rid=50)]))
                self.assertEqual(probs == [], passes, probs)

    def test_status_checked_independently_of_conclusion(self):
        # A run that reports a conclusion while not completed is still not done.
        for name in ("Lint", "Chord chip fit (real Chromium)"):
            with self.subTest(name=name):
                runs = [r for r in all_green() if r["name"] != name]
                runs.append(run(name, status="in_progress", conclusion="success"))
                self.assertTrue(self.ok(runs))

    def test_non_required_other_app_red_ignored(self):
        self.assertEqual(self.ok(all_green([run("Vercel", conclusion="failure", app_id=8329)])), [])

    def test_non_required_wrong_head_sha_fails(self):
        self.assertTrue(self.ok(all_green([run("Chord chip fit (real Chromium)", sha=OTHER)])))

    def test_deploy_workflow_own_runs_excluded_by_suite(self):
        extra = [
            run("CI green gate (deployed SHA on v3/main)", status="in_progress", conclusion=None, suite=DEPLOY_SUITE),
            run("Deploy Worker to Fly.io", status="queued", conclusion=None, suite=DEPLOY_SUITE),
            run("Deploy Web to Vercel", status="completed", conclusion="skipped", suite=DEPLOY_SUITE),
            # an earlier, too-early dispatch whose gate went red must not block a re-dispatch
            run("CI green gate (deployed SHA on v3/main)", conclusion="failure", suite=OLD_DEPLOY_SUITE),
        ]
        self.assertEqual(self.ok(all_green(extra)), [])

    def test_deploy_job_names_outside_deploy_suite_are_judged(self):
        # No name-based exclusion: a red "Deploy Worker to Fly.io" from any other suite blocks.
        for name in ("Deploy Worker to Fly.io", "CI green gate (deployed SHA on v3/main)"):
            with self.subTest(name=name):
                self.assertTrue(self.ok(all_green([run(name, status="in_progress", conclusion=None, suite=4242)])))

    def test_required_context_in_deploy_suite_cannot_satisfy(self):
        runs = [r for r in all_green() if r["name"] != "Lint"]
        runs.append(run("Lint", suite=DEPLOY_SUITE))
        probs = self.ok(runs)
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("Lint", probs[0])

    def test_check_run_without_suite_is_judged(self):
        r = run("Deploy Worker to Fly.io", status="queued", conclusion=None)
        del r["check_suite"]
        self.assertTrue(self.ok(all_green([r])))

    def test_self_run_must_be_listed(self):
        probs = self.ok(all_green(), deploy_runs=[wr(OLD_RUN_ID, OLD_DEPLOY_SUITE)])
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("own run", probs[0])
        self.assertTrue(self.ok(all_green(), deploy_runs=[]))

    def test_deploy_runs_wrong_path_fails(self):
        for path in (".github/workflows/ci.yml", "deploy.yml", None):
            with self.subTest(path=path):
                self.assertTrue(self.ok(all_green(), deploy_runs=[wr(path=path)]))

    def test_deploy_runs_bad_suite_fails(self):
        for suite in (None, "9001", True):
            with self.subTest(suite=suite):
                self.assertTrue(self.ok(all_green(), deploy_runs=[wr(suite=suite)]))

    def test_deploy_runs_garbage_fails(self):
        for text in ("{bad", "[1]", '"x"'):
            with self.subTest(text=text):
                self.assertTrue(gate.evaluate(SHA, ndjson(all_green()), cmp(), text, RUN_ID))

    def test_bad_run_id_fails(self):
        for rid in (None, 0, -1, "777", True):
            with self.subTest(rid=rid):
                self.assertTrue(self.ok(all_green(), run_id=rid))

    def test_no_runs_fails_for_all_ten(self):
        self.assertEqual(len(self.ok([])), 10)
        self.assertTrue(all("(required)" in p for p in self.ok([])))

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
                self.assertTrue(gate.evaluate(SHA, text, cmp(), ndjson(DEPLOY_RUNS), RUN_ID))

    def test_runs_array_and_envelope_forms(self):
        runs = all_green()
        dr = ndjson(DEPLOY_RUNS)
        self.assertEqual(gate.evaluate(SHA, json.dumps(runs), cmp(), dr, RUN_ID), [])
        self.assertEqual(gate.evaluate(SHA, json.dumps({"check_runs": runs}), cmp(), dr, RUN_ID), [])

    def test_bad_sha_fails(self):
        for sha in ("", "v3/main", SHA[:39], SHA.upper(), SHA + "0", None):
            with self.subTest(sha=sha):
                self.assertTrue(gate.evaluate(sha, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID))


class Main(unittest.TestCase):
    def _main(self, runs_text, compare_text, sha=SHA, run_id=str(RUN_ID)):
        with tempfile.TemporaryDirectory() as d:
            rp, cp, dp = (os.path.join(d, n) for n in ("r.ndjson", "c.json", "d.ndjson"))
            Path(rp).write_text(runs_text, encoding="utf-8")
            Path(cp).write_text(compare_text, encoding="utf-8")
            Path(dp).write_text(ndjson(DEPLOY_RUNS), encoding="utf-8")
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = gate.main(
                    ["--sha", sha, "--runs", rp, "--compare", cp, "--deploy-runs", dp, "--run-id", run_id]
                )
            return rc, buf.getvalue()

    def test_main_ok(self):
        rc, out = self._main(ndjson(all_green()), cmp())
        self.assertEqual(rc, 0, out)
        self.assertIn("OK", out)

    def test_main_fail(self):
        rc, out = self._main(ndjson(all_green()[:-1]), cmp())
        self.assertEqual(rc, 1)
        self.assertIn("FAIL", out)

    def test_main_non_numeric_run_id_fails(self):
        rc, out = self._main(ndjson(all_green()), cmp(), run_id="abc")
        self.assertEqual(rc, 1, out)

    def test_main_missing_file_fails(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = gate.main(
                ["--sha", SHA, "--runs", "/nonexistent/x", "--compare", "/nonexistent/y",
                 "--deploy-runs", "/nonexistent/z", "--run-id", "1"]
            )
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
        lines = sorted(l.split("#")[0].strip() for l in perms.group(1).splitlines() if l.strip())
        self.assertEqual(lines, ["actions: read", "checks: read", "contents: read"])
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

    def _gate_steps(self):
        g = self.jobs["ci-green-gate"]
        parts = re.split(r"\n      - ", "\n" + g.split("\n    steps:\n", 1)[1])
        return [s for s in parts if s.strip()]

    def _run_block(self, step):
        m = re.search(r"\n        run: \|\n((?:          .*(?:\n|$)|\s*\n)+)", "\n" + step)
        self.assertIsNotNone(m, step)
        return m.group(1)

    def test_gate_job_cannot_be_neutered(self):
        # R1 A-2: continue-on-error, `|| true`-style short-circuits, or a fetch
        # step without `set -euo pipefail` would let a failed check pass.
        g = self.jobs["ci-green-gate"]
        self.assertNotIn("continue-on-error", g)
        self.assertNotRegex(g, r"\n    if:")
        steps = self._gate_steps()
        named = {re.search(r"name: (.*)", s).group(1): s for s in steps if re.search(r"name: (.*)", s)}
        fetch = named["Fetch check-runs and v3/main ancestry for the deployed SHA"]
        check = named["Require main CI green on the deployed SHA"]
        for label, step in (("fetch", fetch), ("check", check)):
            with self.subTest(step=label):
                self.assertNotIn("\n        if:", "\n" + step)
                body = self._run_block(step)
                first = [l.strip() for l in body.splitlines() if l.strip()][0]
                self.assertEqual(first, "set -euo pipefail")
                self.assertNotIn("||", body)
                self.assertNotRegex(body, r"(^|[\s;&|])(true|:)(\s|;|$)")
                self.assertNotIn("set +e", body)
                self.assertNotIn("exit 0", body)
        fb = self._run_block(fetch)
        for needle in ("commits/$SHA/check-runs?filter=latest", "compare/$SHA...v3/main",
                       "actions/workflows/deploy.yml/runs?head_sha=$SHA", "actions/runs/$RUN_ID"):
            self.assertIn(needle, fb)
        cb = self._run_block(check)
        cl = [l.strip() for l in cb.splitlines() if l.strip()]
        self.assertTrue(cl[1].startswith("python3 -I -u scripts/ci_green_gate.py "), cl)
        # one command: every line after it is a backslash continuation of it
        self.assertTrue(all(l.endswith("\\") for l in cl[1:-1]), cl)
        for flag in ("--sha \"$SHA\"", "--run-id \"$RUN_ID\"", "--runs ", "--compare ", "--deploy-runs "):
            self.assertIn(flag, cb)
        # every input file the check reads is one the fetch step wrote
        files = {
            flag: re.search(flag + r' "\$RUNNER_TEMP/([\w.-]+)"', cb)
            for flag in ("--runs", "--compare", "--deploy-runs")
        }
        for flag, m in files.items():
            with self.subTest(flag=flag):
                self.assertIsNotNone(m, (flag, cb))
                self.assertRegex(fb, r'>>? "\$RUNNER_TEMP/' + re.escape(m.group(1)) + '"')
        self.assertEqual(len(steps), 3, steps)

    def test_uses_pinned_to_full_sha(self):
        for m in re.finditer(r"uses:\s*([^\s#]+)", self.text):
            ref = m.group(1)
            if ref.startswith("./"):
                continue
            with self.subTest(uses=ref):
                self.assertRegex(ref, r"@[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
