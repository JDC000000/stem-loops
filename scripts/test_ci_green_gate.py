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
REF = "refs/heads/v3/main"


def runner_env(sha=SHA, ref=REF, run_id=RUN_ID):
    """The runner's own GITHUB_* values for a matching run."""
    return {"GITHUB_SHA": sha, "GITHUB_REF": ref, "GITHUB_RUN_ID": str(run_id)}


def ev(sha, runs_text, compare_text, deploy_runs_text, run_id, ref=REF, env=None):
    """gate.evaluate for a run whose runner env matches its arguments (unless env given)."""
    if env is None:
        env = runner_env(sha, ref, run_id)
    return gate.evaluate(sha, runs_text, compare_text, deploy_runs_text, run_id, ref, env)


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
        return ev(
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
                self.assertTrue(ev(SHA, ndjson(all_green()), cmp(), text, RUN_ID))

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
                self.assertTrue(ev(SHA, text, cmp(), ndjson(DEPLOY_RUNS), RUN_ID))

    def test_runs_array_and_envelope_forms(self):
        runs = all_green()
        dr = ndjson(DEPLOY_RUNS)
        self.assertEqual(ev(SHA, json.dumps(runs), cmp(), dr, RUN_ID), [])
        self.assertEqual(ev(SHA, json.dumps({"check_runs": runs}), cmp(), dr, RUN_ID), [])

    def test_bad_sha_fails(self):
        for sha in ("", "v3/main", SHA[:39], SHA.upper(), SHA + "0", None):
            with self.subTest(sha=sha):
                self.assertTrue(ev(sha, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID))

    # --- run identity: ref must be v3/main; --sha/--ref/--run-id must equal the runner env ---
    def test_other_refs_fail(self):
        for ref in ("refs/heads/main", "refs/heads/feat/x", "refs/tags/stem-loops-com-2026-11-02",
                    "refs/pull/1/merge", "v3/main", "refs/heads/v3/main/x", "", None):
            with self.subTest(ref=ref):
                probs = ev(SHA, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID, ref=ref,
                           env=runner_env(ref=ref if isinstance(ref, str) else ""))
                self.assertTrue(any("is not refs/heads/v3/main" in p for p in probs), probs)

    def test_runner_env_must_be_present(self):
        for var in ("GITHUB_SHA", "GITHUB_REF", "GITHUB_RUN_ID"):
            for bad in (None, ""):
                with self.subTest(var=var, bad=bad):
                    env = runner_env()
                    if bad is None:
                        del env[var]
                    else:
                        env[var] = bad
                    probs = ev(SHA, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID, env=env)
                    self.assertEqual(len(probs), 1, probs)
                    self.assertIn(var, probs[0])
        self.assertTrue(ev(SHA, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID, env={}))

    def test_gated_sha_must_equal_runner_sha(self):
        # A gate fed an older green SHA than the one this run checks out and deploys fails.
        probs = ev(SHA, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID,
                   env=runner_env(sha=OTHER))
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("GITHUB_SHA", probs[0])

    def test_gated_ref_and_run_id_must_equal_runner(self):
        probs = ev(SHA, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID,
                   env=runner_env(ref="refs/heads/feat/x"))
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("GITHUB_REF", probs[0])
        probs = ev(SHA, ndjson(all_green()), cmp(), ndjson(DEPLOY_RUNS), RUN_ID,
                   env=runner_env(run_id=OLD_RUN_ID))
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("GITHUB_RUN_ID", probs[0])


class Main(unittest.TestCase):
    def _main(self, runs_text, compare_text, sha=SHA, run_id=str(RUN_ID), ref=REF, env=None):
        with tempfile.TemporaryDirectory() as d:
            rp, cp, dp = (os.path.join(d, n) for n in ("r.ndjson", "c.json", "d.ndjson"))
            Path(rp).write_text(runs_text, encoding="utf-8")
            Path(cp).write_text(compare_text, encoding="utf-8")
            Path(dp).write_text(ndjson(DEPLOY_RUNS), encoding="utf-8")
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = gate.main(
                    ["--sha", sha, "--runs", rp, "--compare", cp, "--deploy-runs", dp,
                     "--run-id", run_id, "--ref", ref],
                    runner_env(sha, ref, run_id) if env is None else env,
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

    def test_main_other_ref_fails(self):
        rc, out = self._main(ndjson(all_green()), cmp(), ref="refs/heads/feat/x")
        self.assertEqual(rc, 1, out)
        self.assertIn("refs/heads/feat/x", out)

    def test_main_without_runner_env_fails(self):
        rc, out = self._main(ndjson(all_green()), cmp(), env={})
        self.assertEqual(rc, 1, out)
        self.assertIn("GITHUB_SHA is not set", out)

    def test_main_ref_is_required(self):
        with self.assertRaises(SystemExit), redirect_stdout(io.StringIO()), \
                __import__("contextlib").redirect_stderr(io.StringIO()):
            gate.main(["--sha", SHA, "--runs", "x", "--compare", "y", "--deploy-runs", "z",
                       "--run-id", "1"], runner_env())

    def test_main_missing_file_fails(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = gate.main(
                ["--sha", SHA, "--runs", "/nonexistent/x", "--compare", "/nonexistent/y",
                 "--deploy-runs", "/nonexistent/z", "--run-id", "1", "--ref", REF],
                runner_env(run_id=1),
            )
        self.assertEqual(rc, 1)


def rules_ndjson(contexts, ruleset_id=26478884, extra_rules=()):
    rules = [{"type": "deletion", "ruleset_id": ruleset_id},
             {"type": "required_status_checks", "ruleset_source_type": "Repository",
              "ruleset_source": "JDC000000/stem-loops", "ruleset_id": ruleset_id,
              "parameters": {"strict_required_status_checks_policy": False,
                             "required_status_checks": [
                                 {"context": c, "integration_id": 15368} for c in contexts]}}]
    rules.extend(extra_rules)
    return ndjson(rules)


class RulesetDrift(unittest.TestCase):
    def _drift(self, text=None, path=None, argv=None):
        with tempfile.TemporaryDirectory() as d:
            if argv is None:
                fp = path or os.path.join(d, "rules.ndjson")
                if text is not None:
                    Path(fp).write_text(text, encoding="utf-8")
                argv = ["--drift", fp]
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = gate.main(argv, {})
            return rc, buf.getvalue()

    def test_in_sync_no_warning(self):
        rc, out = self._drift(rules_ndjson(gate.REQUIRED_CONTEXTS))
        self.assertEqual(rc, 0)
        self.assertNotIn("::warning", out)
        self.assertIn("ruleset-drift: OK", out)
        # order does not matter
        self.assertEqual(gate.ruleset_drift(rules_ndjson(reversed(gate.REQUIRED_CONTEXTS))), [])

    def test_added_context_warns(self):
        rc, out = self._drift(rules_ndjson(gate.REQUIRED_CONTEXTS + ("New job",)))
        self.assertEqual(rc, 0)
        self.assertIn("::warning title=ruleset drift::", out)
        self.assertIn("New job", out)
        self.assertIn("under-checks", out)

    def test_removed_or_renamed_context_warns(self):
        ctx = list(gate.REQUIRED_CONTEXTS)
        ctx[0] = "Lint (renamed)"
        w = gate.ruleset_drift(rules_ndjson(ctx))
        self.assertEqual(len(w), 2, w)
        self.assertTrue(any("Lint (renamed)" in x for x in w))
        self.assertTrue(any("'Lint'" in x and "no longer requires" in x for x in w))

    def test_other_ruleset_ignored_and_absent_ruleset_warns(self):
        w = gate.ruleset_drift(rules_ndjson(["Something else"], ruleset_id=1))
        self.assertEqual(len(w), 1, w)
        self.assertIn("no required_status_checks rule", w[0])
        text = rules_ndjson(gate.REQUIRED_CONTEXTS) + rules_ndjson(["X"], ruleset_id=1)
        self.assertEqual(gate.ruleset_drift(text), [])

    def test_read_errors_never_fail(self):
        for text in ("", "{bad", '{"message": "Not Found"}', "[1]",
                     ndjson([{"type": "required_status_checks", "ruleset_id": 26478884,
                              "parameters": {"required_status_checks": 5}}])):
            with self.subTest(text=text):
                rc, out = self._drift(text)
                self.assertEqual(rc, 0, out)
                self.assertIn("::warning", out)
        rc, out = self._drift(path="/nonexistent/rules.ndjson")
        self.assertEqual(rc, 0)
        self.assertIn("::warning", out)
        for argv in (["--drift"], ["--drift", "a", "b"]):
            with self.subTest(argv=argv):
                rc, out = self._drift(argv=argv)
                self.assertEqual(rc, 0)
                self.assertIn("::warning", out)


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


NON_DEPLOY_JOBS = ("ci-green-gate", "ruleset-drift")
DEPLOY_JOBS = ("deploy-web", "deploy-worker")
DEPLOY_SECRETS = {
    "deploy-web": {"VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"},
    "deploy-worker": {"FLY_API_TOKEN"},
}

# The exact fetch block (R1 sonnet M9/M10, fable M9): a hardcoded compare result, a
# dropped --paginate or a changed URL/jq is a test failure, not a silent gap.
EXPECTED_FETCH = [
    "set -euo pipefail",
    'gh api --paginate "repos/$REPO/commits/$SHA/check-runs?filter=latest&per_page=100" \\',
    "--jq '.check_runs[]' > \"$RUNNER_TEMP/check-runs.ndjson\"",
    'gh api "repos/$REPO/compare/$SHA...v3/main" \\',
    "--jq '{status: .status, merge_base: .merge_base_commit.sha}' > \"$RUNNER_TEMP/compare.json\"",
    'gh api --paginate "repos/$REPO/actions/workflows/deploy.yml/runs?head_sha=$SHA&per_page=100" \\',
    "--jq '.workflow_runs[] | {id: .id, check_suite_id: .check_suite_id, path: .path}' > \"$RUNNER_TEMP/deploy-runs.ndjson\"",
    'gh api "repos/$REPO/actions/runs/$RUN_ID" \\',
    "--jq '{id: .id, check_suite_id: .check_suite_id, path: .path}' >> \"$RUNNER_TEMP/deploy-runs.ndjson\"",
]
EXPECTED_CHECK = [
    "set -euo pipefail",
    'python3 -I -u scripts/ci_green_gate.py --sha "$SHA" --ref "$REF" --run-id "$RUN_ID" \\',
    '--runs "$RUNNER_TEMP/check-runs.ndjson" --compare "$RUNNER_TEMP/compare.json" \\',
    '--deploy-runs "$RUNNER_TEMP/deploy-runs.ndjson"',
]
EXPECTED_DRIFT = [
    "set -uo pipefail",
    """if gh api --paginate "repos/$REPO/rules/branches/v3/main" --jq '.[]' > "$RUNNER_TEMP/rules.ndjson"; then""",
    'python3 -I -u scripts/ci_green_gate.py --drift "$RUNNER_TEMP/rules.ndjson" \\',
    '|| echo "::warning title=ruleset drift::drift check exited non-zero (ignored)"',
    "else",
    'echo "::warning title=ruleset drift::cannot read v3/main branch rules with this token; drift not checked"',
    "fi",
    "exit 0",
]

_IF_TOKEN = re.compile(
    r"\s*(?:(?P<op>&&|\|\||==|!=|!|\(|\))|(?P<str>'[^']*')|(?P<kw>true|false)"
    r"|(?P<inp>inputs\.(?:target|gate_only)))"
)


def eval_if(expr, inputs):
    """Evaluate a deploy job's `if:` (inputs only; anything else raises) like Actions does."""
    m = re.fullmatch(r"\$\{\{(.*)\}\}", expr.strip())
    body = m.group(1) if m else expr
    out, pos = [], 0
    while pos < len(body.rstrip()):
        t = _IF_TOKEN.match(body, pos)
        if not t:
            raise ValueError(f"unsupported token in if: {body[pos:]!r}")
        pos = t.end()
        if t.group("op"):
            out.append({"&&": " and ", "||": " or ", "!": " not "}.get(t.group("op"), t.group("op")))
        elif t.group("str"):
            out.append(repr(t.group("str")[1:-1]))
        elif t.group("kw"):
            out.append(t.group("kw").capitalize())
        else:
            out.append(repr(inputs[t.group("inp").split(".", 1)[1]]))
    return bool(eval("".join(out), {"__builtins__": {}}, {}))  # noqa: S307 -- tokens whitelisted


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
        deploys = [j for j in self.jobs if j not in NON_DEPLOY_JOBS]
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
        self.assertEqual([l.strip() for l in fb.splitlines() if l.strip()], EXPECTED_FETCH)
        cb = self._run_block(check)
        cl = [l.strip() for l in cb.splitlines() if l.strip()]
        self.assertEqual(cl, EXPECTED_CHECK)
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

    # --- S22 hardening (GUARD-main R1 sonnet 88 / fable 88) ---

    def _top_level(self):
        return [m.group(1) for m in re.finditer(r"^([^\s#][^:]*):", self.text, re.M)]

    def test_trigger_is_workflow_dispatch_only(self):
        # sonnet M8 / fable M1: a push/schedule/workflow_run trigger would deploy undispatched.
        self.assertEqual(self._top_level(), ["name", "on", "permissions", "jobs"])
        on = re.search(r"^on:\n((?:[ #].*\n|\n)+)", self.text, re.M)
        self.assertIsNotNone(on)
        keys = re.findall(r"^  ([^\s#][^:]*):", on.group(1), re.M)
        self.assertEqual(keys, ["workflow_dispatch"])
        inputs = re.findall(r"^      ([^\s#][^:]*):", on.group(1), re.M)
        self.assertEqual(inputs, ["target", "gate_only"])

    def test_gate_only_input_is_boolean_default_false(self):
        on = re.search(r"^on:\n((?:[ #].*\n|\n)+)", self.text, re.M).group(1)
        g = re.search(r"\n      gate_only:\n((?:        .*\n)+)", on)
        self.assertIsNotNone(g, on)
        lines = sorted(l.strip() for l in g.group(1).splitlines())
        self.assertIn("type: boolean", lines)
        self.assertIn("default: false", lines)
        self.assertIn("required: false", lines)

    def test_workflow_default_permissions_empty(self):
        self.assertRegex(self.text, r"\npermissions: \{\}\n")

    def test_job_set_is_exact(self):
        self.assertEqual(sorted(self.jobs), sorted(NON_DEPLOY_JOBS + DEPLOY_JOBS))

    def test_deploy_jobs_use_production_environment(self):
        # The real control against other-ref dispatch and re-runs of pre-gate runs:
        # Environment `production`, deployment branch v3/main only, holding the secrets.
        self.assertEqual(len(re.findall(r"environment:", self.text)), 2)
        for j in DEPLOY_JOBS:
            with self.subTest(job=j):
                self.assertEqual(len(re.findall(r"\n    environment: production\n", self.jobs[j] + "\n")), 1)
        for j in NON_DEPLOY_JOBS:
            with self.subTest(job=j):
                self.assertNotIn("environment", re.sub(r"#.*", "", self.jobs[j]))

    def test_secrets_only_in_deploy_jobs(self):
        for j in self.jobs:
            with self.subTest(job=j):
                used = set(re.findall(r"secrets\.([A-Z0-9_]+)", self.jobs[j]))
                self.assertEqual(used, DEPLOY_SECRETS.get(j, set()))
                self.assertNotIn("secrets[", self.jobs[j])
                self.assertNotIn("toJSON(secrets", self.jobs[j])

    def test_deploy_jobs_if_pinned(self):
        for j, tgt in (("deploy-web", "web"), ("deploy-worker", "worker")):
            with self.subTest(job=j):
                ifs = re.findall(r"\n    if: (.*)", self.jobs[j])
                self.assertEqual(ifs, ["${{ inputs.gate_only != true && "
                                       f"(inputs.target == 'all' || inputs.target == '{tgt}') }}}}"])

    def test_deploy_runs_only_when_gate_succeeded_and_not_gate_only(self):
        # Model of Actions: an `if:` with no status function implies success(), i.e. every
        # `needs:` job succeeded; a failed/skipped/cancelled gate skips the job.
        for j, tgt in (("deploy-web", "web"), ("deploy-worker", "worker")):
            body = self.jobs[j]
            needs = re.findall(r"\n    needs: \[?([\w-]+)\]?\s*(?=\n)", body)
            self.assertEqual(needs, ["ci-green-gate"])
            self.assertNotRegex(body, r"success\(\)|always\(\)|failure\(\)|cancelled\(\)|\bneeds\.")
            expr = re.search(r"\n    if: (.*)", body).group(1)
            for gate_result in ("success", "failure", "skipped", "cancelled"):
                for gate_only in (False, True):
                    for target in ("all", "web", "worker"):
                        with self.subTest(job=j, gate=gate_result, gate_only=gate_only, target=target):
                            runs = gate_result == "success" and eval_if(
                                expr, {"target": target, "gate_only": gate_only})
                            want = (gate_result == "success" and not gate_only
                                    and target in ("all", tgt))
                            self.assertEqual(runs, want)

    def test_eval_if_rejects_unknown_tokens(self):
        for expr in ("${{ always() }}", "${{ github.ref == 'x' }}", "${{ inputs.other }}"):
            with self.subTest(expr=expr), self.assertRaises((ValueError, KeyError)):
                eval_if(expr, {"target": "all", "gate_only": False})

    def test_gate_and_drift_jobs_have_no_if_or_needs(self):
        for j in NON_DEPLOY_JOBS:
            with self.subTest(job=j):
                self.assertNotRegex(self.jobs[j], r"\n    (if|needs):")

    def test_no_job_needs_ruleset_drift(self):
        # Drift is advisory: nothing may wait on it (a revert redeploy must not be blocked).
        code = "\n".join(re.sub(r"(^|\s)#.*", "", l) for l in self.text.splitlines())
        self.assertEqual(re.findall(r".*ruleset-drift.*", code), ["  ruleset-drift:"])
        self.assertNotRegex(code, r"needs:[^\n]*\n?\s*-?\s*\[?[^\n]*drift")

    def test_drift_job_is_non_blocking_and_pinned(self):
        d = self.jobs["ruleset-drift"]
        perms = re.search(r"\n    permissions:\n((?:      .*\n?)+)", d)
        self.assertEqual([l.strip() for l in perms.group(1).splitlines() if l.strip()], ["contents: read"])
        self.assertNotIn("continue-on-error", d)  # non-blocking by construction, not by flag
        runs = re.findall(r"\n        run: \|\n((?:          .*(?:\n|$)|\s*\n)+)", d)
        self.assertEqual(len(runs), 1)
        self.assertEqual([l.strip() for l in runs[0].splitlines() if l.strip()], EXPECTED_DRIFT)
        self.assertIn("persist-credentials: false", d)

    def test_gate_steps_judge_this_runs_sha_ref_and_run_id(self):
        # fable M7: a gate fed a fixed old green SHA would judge a commit other than the
        # one deployed. Pin the env of both gate steps exactly.
        steps = self._gate_steps()
        named = {re.search(r"name: (.*)", s).group(1): s for s in steps if re.search(r"name: (.*)", s)}
        want = {
            "Fetch check-runs and v3/main ancestry for the deployed SHA": [
                "GH_TOKEN: ${{ github.token }}", "REPO: ${{ github.repository }}",
                "SHA: ${{ github.sha }}", "RUN_ID: ${{ github.run_id }}"],
            "Require main CI green on the deployed SHA": [
                "SHA: ${{ github.sha }}", "REF: ${{ github.ref }}", "RUN_ID: ${{ github.run_id }}"],
        }
        for name, env in want.items():
            with self.subTest(step=name):
                m = re.search(r"\n        env:\n((?:          .*\n)+)", "\n" + named[name])
                self.assertIsNotNone(m)
                self.assertEqual([l.strip() for l in m.group(1).splitlines()], env)

    def test_no_env_sets_github_or_runner_vars(self):
        # The gate cross-checks GITHUB_SHA/GITHUB_REF/GITHUB_RUN_ID; nothing may set them.
        self.assertNotRegex(self.text, r"\n\s+(GITHUB|RUNNER)_[A-Z_]*:")
        self.assertNotRegex(self.text, r"\n\s+env:\s*\$\{\{")

    def test_deploy_checkouts_build_the_dispatched_sha(self):
        # fable M8: `ref:`/`repository:` on a deploy checkout would build a commit the
        # gate never judged.
        for j in DEPLOY_JOBS:
            body = self.jobs[j]
            steps = re.split(r"\n      - ", "\n" + body.split("\n    steps:\n", 1)[1])
            co = [s for s in steps if s.lstrip().startswith("uses: actions/checkout@")]
            with self.subTest(job=j):
                self.assertEqual(len(co), 1, steps)
                with_keys = re.findall(r"^          ([\w-]+):", co[0], re.M)
                self.assertEqual(with_keys, ["persist-credentials"])
                self.assertIn("persist-credentials: false", co[0])
                self.assertNotRegex(body, r"\n\s+(ref|repository|path):")
                self.assertNotRegex(body, r"git (checkout|switch|fetch|reset|pull)")

    def test_deploy_jobs_least_privilege(self):
        for j in DEPLOY_JOBS:
            with self.subTest(job=j):
                perms = re.search(r"\n    permissions:\n((?:      .*\n?)+)", self.jobs[j])
                self.assertIsNotNone(perms)
                self.assertEqual([l.strip() for l in perms.group(1).splitlines() if l.strip()],
                                 ["contents: read"])

    def test_no_expressions_inside_any_run(self):
        # COMMON-RULES: no `${{ }}` inside run: (one-line and block forms, every job).
        for m in re.finditer(r"\n(\s+)(?:- )?run: (.*)((?:\n\1  .*|\n\s*(?=\n))*)", self.text):
            with self.subTest(run=m.group(2)[:60]):
                self.assertNotIn("${{", m.group(2) + m.group(3))

    def test_rerun_rule_documented(self):
        self.assertIn("NEVER `gh run rerun`", self.text)
        self.assertIn("dispatch a NEW run", self.text)

    def test_uses_pinned_to_full_sha(self):
        for m in re.finditer(r"uses:\s*([^\s#]+)", self.text):
            ref = m.group(1)
            if ref.startswith("./"):
                continue
            with self.subTest(uses=ref):
                self.assertRegex(ref, r"@[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
