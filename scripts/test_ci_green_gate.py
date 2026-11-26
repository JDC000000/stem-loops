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

    def test_wrong_path_entry_excludes_nothing(self):
        # fable P6: a non-deploy.yml run (here: ci.yml's own suite) must not have its
        # check suite excluded; the only problem is the path itself.
        probs = self.ok(all_green(), deploy_runs=DEPLOY_RUNS + [
            wr(4242, CI_SUITE, ".github/workflows/ci.yml")])
        self.assertEqual(len(probs), 1, probs)
        self.assertIn("ci.yml", probs[0])

    def test_non_integer_suite_is_reported(self):
        # fable P7: reported by name, not silently skipped.
        for suite in (None, "9001", True, 1.5):
            with self.subTest(suite=suite):
                probs = self.ok(all_green(), deploy_runs=DEPLOY_RUNS + [wr(4243, suite)])
                self.assertEqual(len(probs), 1, probs)
                self.assertIn("no integer check_suite_id", probs[0])

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

    def test_drift_flag_only_as_first_argument(self):
        # fable N15: `--drift` anywhere else must not switch the gate to warn-only mode.
        for argv in (["--sha", SHA, "--drift", "x"], ["--sha", SHA, "--ref", REF, "--drift"]):
            with self.subTest(argv=argv):
                buf = io.StringIO()
                with self.assertRaises(SystemExit) as cm, redirect_stdout(buf), \
                        __import__("contextlib").redirect_stderr(io.StringIO()):
                    gate.main(argv, runner_env())
                self.assertNotEqual(cm.exception.code, 0)
                self.assertNotIn("ruleset-drift", buf.getvalue())

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
    """Split deploy.yml into {job_id: body} (top-level `jobs:` children at 2-space indent).

    A column-0 `#` comment does not end the block (PR445 R2 fable R5/R21: stopping there
    hid every job after it); only a column-0 non-comment line (a new top-level key) does.
    """
    m = re.search(r"^jobs:\n", text, re.M)
    assert m, "no jobs: key"
    jobs, cur = {}, None
    for line in text[m.end():].splitlines():
        if line.startswith("#"):
            continue
        if re.match(r"^\S", line):
            break
        jm = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if jm:
            cur = jm.group(1)
            jobs[cur] = []
        elif cur:
            jobs[cur].append(line)
    return {k: "\n".join(v) for k, v in jobs.items()}


class YamlSubsetError(ValueError):
    pass


def _yaml_scalar(s):
    """A plain or quoted scalar; an inline ` #` comment after it is dropped."""
    s = s.strip()
    if s[:1] in ("'", '"'):
        q = s[0]
        m = re.match(r"'((?:[^']|'')*)'" if q == "'" else r'"((?:[^"\\]|\\.)*)"', s)
        if not m or s[m.end():].strip()[:1] not in ("", "#"):
            raise YamlSubsetError(f"bad quoted scalar {s!r}")
        if q == '"' and "\\" in m.group(1):
            # PR450 R1 fable B1: `"al\x77ays()"` is `always()` to a YAML parser. Fail closed on
            # every double-quoted escape (\x, \u, \U, \", ...) rather than decode some of them.
            raise YamlSubsetError(f"backslash escape in double-quoted scalar {s!r}")
        return m.group(1).replace("''", "'") if q == "'" else m.group(1)
    if s[:1] in ("&", "*", "!", "%", "@", "`", "|", ">", "{", "[") or s.startswith("<<"):
        raise YamlSubsetError(f"unsupported scalar {s!r}")
    return re.split(r"\s#", s, maxsplit=1)[0].rstrip()


_YAML_KEY = re.compile(
    r"""^(?:(?P<q>"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')|(?P<p>[^\s'"#{}\[\],&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?))"""
    r"""(?P<sp>\s*):(?:\s+(?P<v>.*)|$)"""
)


def yaml_subset_load(text):
    """Stdlib loader for the block-YAML subset deploy.yml uses (CI's script tests are stdlib-only).

    Keys are normalised the way a YAML parser (and Actions) sees them: `"needs":`, `'if':`
    and `needs :` all become `needs`, so a structural check cannot be dodged by spelling
    (PR445 R2 fable R1-R4/R7/R16-R18). Comments are dropped wherever they sit, column 0
    included. Anything outside the subset (anchors, aliases, tags, non-empty flow maps,
    tabs, duplicate keys, documents, any backslash escape in a double-quoted scalar,
    multi-line flow scalars) raises YamlSubsetError instead of being guessed at, so every
    accepted scalar is byte-equal to the value a YAML parser yields.
    Returns (tree, spellings): spellings lists every key whose source text was not the
    bare key itself (quoted, or whitespace before the colon).
    """
    raw = text.splitlines()
    spellings = []

    def ind(line):
        return len(line) - len(line.lstrip(" "))

    def nxt(i):
        while i < len(raw):
            s = raw[i].strip()
            if s and not s.startswith("#"):
                if "\t" in raw[i][: ind(raw[i]) + 1]:
                    raise YamlSubsetError(f"tab indent at line {i + 1}")
                if s in ("---", "...") or s.startswith("%"):
                    raise YamlSubsetError(f"document marker at line {i + 1}")
                return i
            i += 1
        return i

    def block_scalar(i, parent, header):
        if not re.fullmatch(r"[|>][+-]?", header):
            raise YamlSubsetError(f"unsupported block scalar header {header!r}")
        out, n = [], None
        while i < len(raw) and (not raw[i].strip() or ind(raw[i]) > parent):
            if raw[i].strip():
                n = ind(raw[i]) if n is None else n
                if ind(raw[i]) < n:
                    raise YamlSubsetError(f"bad block scalar indent at line {i + 1}")
            out.append(raw[i][n:] if n is not None and raw[i].strip() else "")
            i += 1
        while out and not out[-1]:
            out.pop()
        return ("\n" if header[0] == "|" else " ").join(out) + "\n", i

    def value(rest, i, indent):
        """The value after `key:` / `- ` on line i-1; i is the next physical line."""
        rest = rest.strip() if rest else ""
        if rest and not rest.startswith("#"):
            if rest[0] in "|>":
                return block_scalar(i, indent, re.split(r"\s", rest, maxsplit=1)[0])
            if re.fullmatch(r"\{\}\s*(#.*)?", rest):
                return {}, i
            if rest[0] == "[":
                m = re.fullmatch(r"\[([^\[\]{}]*)\]\s*(#.*)?", rest)
                if not m:
                    raise YamlSubsetError(f"unsupported flow sequence {rest!r}")
                return [_yaml_scalar(x) for x in m.group(1).split(",") if x.strip()], i
            return _yaml_scalar(rest), i
        j = nxt(i)
        if j < len(raw) and ind(raw[j]) > indent:
            return node(j, ind(raw[j]))
        if j < len(raw) and ind(raw[j]) == indent and raw[j].lstrip().startswith("- "):
            return seq(j, indent)
        return None, i

    def node(i, indent):
        return seq(i, indent) if re.match(r"-(\s|$)", raw[i].lstrip()) else mapping(i, indent)

    def mapping(i, indent, first=None):
        out = {}
        while True:
            j = nxt(i) if first is None else i
            if j >= len(raw) or (first is None and ind(raw[j]) < indent):
                return out, j
            line = first if first is not None else raw[j]
            first = None
            if ind(line) != indent:
                raise YamlSubsetError(f"bad indent at line {j + 1}: {line!r}")
            body = line[indent:]
            if re.match(r"-(\s|$)", body):
                return out, j  # a compact sequence belongs to the parent key
            m = _YAML_KEY.match(body)
            if not m:
                raise YamlSubsetError(f"not a mapping entry at line {j + 1}: {line!r}")
            key = _yaml_scalar(m.group("q")) if m.group("q") else m.group("p").strip()
            if m.group("q") or m.group("sp"):
                spellings.append((j + 1, body.split(":", 1)[0] if not m.group("q") else m.group("q")))
            if key in out:
                raise YamlSubsetError(f"duplicate key {key!r} at line {j + 1}")
            out[key], i = value(m.group("v"), j + 1, indent)

    def seq(i, indent):
        out = []
        while True:
            j = nxt(i)
            if j >= len(raw) or ind(raw[j]) < indent:
                return out, j
            if ind(raw[j]) != indent:
                raise YamlSubsetError(f"bad indent at line {j + 1}")
            body = raw[j][indent:]
            if not re.match(r"-(\s|$)", body):
                return out, j
            rest = body[1:]
            item_indent = indent + 1 + (len(rest) - len(rest.lstrip(" ")))
            rest = rest.strip()
            if rest and not rest.startswith("#") and _YAML_KEY.match(rest):
                # `- key: v`: a mapping whose first entry sits on the dash line
                item, i = mapping(j, item_indent, first=" " * item_indent + rest)
            else:
                item, i = value(rest, j + 1, indent)
            out.append(item)

    i = nxt(0)
    tree, i = mapping(i, 0) if i < len(raw) else ({}, i)
    if nxt(i) < len(raw):
        raise YamlSubsetError(f"unparsed content at line {nxt(i) + 1}: {raw[nxt(i)]!r}")
    return tree, spellings


# Actions function names are case-insensitive (`Always()` works), hence IGNORECASE.
STATUS_FUNCS = re.compile(r"\b(always|failure|cancelled|success)\s*\(|\bneeds\.", re.IGNORECASE)


def deploy_structure_violations(text):
    """Structural (parsed, spelling-independent) rules for deploy.yml; [] means it holds.

    Independent of every textual regex in DeployWorkflowWiring, so a quoted or spaced
    key or a column-0 comment inside `jobs:` cannot hide a broken deploy job.
    """
    try:
        tree, spellings = yaml_subset_load(text)
    except YamlSubsetError as e:
        return [f"unparseable: {e}"]
    v = [f"non-bare key spelling at line {n}: {s!r}" for n, s in spellings]
    if list(tree) != ["name", "on", "permissions", "jobs"]:
        v.append(f"top-level keys {list(tree)}")
    if tree.get("permissions") != {}:
        v.append("workflow permissions not {}")
    jobs = tree.get("jobs") or {}
    if not isinstance(jobs, dict) or sorted(jobs) != sorted(NON_DEPLOY_JOBS + DEPLOY_JOBS):
        v.append(f"job set {sorted(jobs) if isinstance(jobs, dict) else jobs!r}")
        jobs = jobs if isinstance(jobs, dict) else {}
    for name, job in jobs.items():
        if not isinstance(job, dict):
            v.append(f"{name}: not a mapping")
            continue
        flat = json.dumps(job)
        secrets = set(re.findall(r"secrets\.([A-Z0-9_]+)", flat))
        if name in NON_DEPLOY_JOBS:
            if list(job) != ["name", "runs-on", "timeout-minutes", "permissions", "steps"]:
                v.append(f"{name}: job keys {list(job)}")
            if secrets or "secrets" in flat:
                v.append(f"{name}: uses secrets")
            for k, step in enumerate(job.get("steps") or []):
                bad = sorted(set(step) - {"uses", "with", "name", "env", "run"}) if isinstance(step, dict) else ["?"]
                if bad:
                    v.append(f"{name}: step {k} keys {bad}")
            continue
        # every other job is a deploy job, whatever its name
        needs = job.get("needs")
        needs = [needs] if isinstance(needs, str) else needs
        if needs != ["ci-green-gate"]:
            v.append(f"{name}: needs {job.get('needs')!r}, want ci-green-gate")
        cond = job.get("if")
        if not isinstance(cond, str):
            v.append(f"{name}: if {cond!r} missing")
        elif STATUS_FUNCS.search(cond):
            v.append(f"{name}: if {cond!r} has a status function or needs.* that overrides the gate")
        else:
            # PR450 R1 sonnet note: a literal `if: true` (or a dropped gate_only clause) passes
            # the deny-list; require that gate_only=true skips the job for every target.
            try:
                if any(eval_if(cond, {"target": t, "gate_only": True}) for t in ("all", "web", "worker")):
                    v.append(f"{name}: if {cond!r} runs with gate_only=true")
            except (ValueError, KeyError, SyntaxError) as e:
                v.append(f"{name}: if {cond!r} not evaluable ({e})")
        if job.get("environment") != "production":
            v.append(f"{name}: environment {job.get('environment')!r}, want production")
        if secrets - DEPLOY_SECRETS.get(name, set()) or "secrets[" in flat or "toJSON(secrets" in flat:
            v.append(f"{name}: secrets {sorted(secrets)}")
        for k in ("continue-on-error", "container", "services", "defaults", "env", "strategy"):
            if k in job:
                v.append(f"{name}: job key {k}")
    return v


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

EXPECTED_DEPLOY_WEB = [
    "name: Deploy Web to Vercel",
    "runs-on: ubuntu-latest",
    "needs: ci-green-gate",
    "if: ${{ inputs.gate_only != true && (inputs.target == 'all' || inputs.target == 'web') }}",
    "environment: production",
    "permissions:",
    "contents: read",
    "steps:",
    "- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "with:",
    "persist-credentials: false",
    "- uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
    "with:",
    "node-version: '20'",
    "- uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4 -- version from package.json packageManager",
    "- name: Install deps",
    "run: pnpm install --frozen-lockfile",
    "- name: Deploy to Vercel",
    'run: npx vercel@66.6.0 deploy --prod --token="$VERCEL_TOKEN"',
    "env:",
    "VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}",
    "VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}",
    "VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}",
]
EXPECTED_DEPLOY_WORKER = [
    "name: Deploy Worker to Fly.io",
    "runs-on: ubuntu-latest",
    "needs: ci-green-gate",
    "if: ${{ inputs.gate_only != true && (inputs.target == 'all' || inputs.target == 'worker') }}",
    "environment: production",
    "permissions:",
    "contents: read",
    "steps:",
    "- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "with:",
    "persist-credentials: false",
    "- uses: superfly/flyctl-actions/setup-flyctl@fc53c09e1bc3be6f54706524e3b82c4f462f77be  # 1.5",
    "- name: Deploy to Fly.io",
    "run: cd apps/worker && flyctl deploy --remote-only --ha=false",
    "env:",
    "FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}",
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

    # --- S22 R2: pin the SHAPE of every job (PR445 R1 fable N1/N2/N21/N26/N27, sonnet N11/N12) ---

    @staticmethod
    def _code_lines(body):
        """Non-blank, non-comment lines of a job body, right-stripped (inline `# vN` kept)."""
        return [l.rstrip() for l in body.splitlines() if l.strip() and not l.strip().startswith("#")]

    def _steps_of(self, job):
        body = "\n".join(self._code_lines(self.jobs[job]))
        parts = re.split(r"\n      - ", "\n" + body.split("\n    steps:\n", 1)[1])
        return ["      - " + p for p in parts if p.strip()]

    @staticmethod
    def _step_keys(step):
        first = re.match(r"      - ([\w-]+):", step).group(1)
        return [first] + re.findall(r"^        ([\w-]+):", step, re.M)

    def test_gate_and_drift_job_keys_exact(self):
        # No container:/services:/defaults:/env:/if:/strategy:/continue-on-error: and a
        # GitHub-hosted runner: the pinned scripts run with the runner's own python3/gh.
        for j in NON_DEPLOY_JOBS:
            with self.subTest(job=j):
                keys = re.findall(r"^    ([\w-]+):", self.jobs[j], re.M)
                self.assertEqual(keys, ["name", "runs-on", "timeout-minutes", "permissions", "steps"])
                self.assertRegex(self.jobs[j], r"\n    runs-on: ubuntu-latest\n")
                self.assertRegex(self.jobs[j], r"\n    timeout-minutes: 5\n")
                for bad in ("container", "services", "defaults", "shell", "working-directory"):
                    self.assertNotRegex("\n".join(self._code_lines(self.jobs[j])), rf"\b{bad}:")

    def test_no_workflow_level_defaults_or_env(self):
        # top-level keys are pinned exactly in test_trigger_is_workflow_dispatch_only;
        # assert the dangerous ones by name as well.
        for bad in ("defaults", "env", "concurrency"):
            self.assertNotRegex(self.text, rf"(?m)^{bad}:")
        self.assertNotRegex(self.text, r"(?m)^\s+shell:")
        self.assertNotRegex(self.text, r"(?m)^\s+defaults:")

    def test_gate_and_drift_step_keys_exact(self):
        # No shell:/working-directory:/if:/continue-on-error:/id: on any step.
        want = {
            "ci-green-gate": [["uses", "with"], ["name", "env", "run"], ["name", "env", "run"]],
            "ruleset-drift": [["uses", "with"], ["name", "env", "run"]],
        }
        for j, shape in want.items():
            with self.subTest(job=j):
                steps = self._steps_of(j)
                self.assertEqual([self._step_keys(s) for s in steps], shape)
                co = steps[0].splitlines()
                self.assertEqual(
                    [l.strip() for l in co],
                    ["- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
                     "with:", "persist-credentials: false"],
                )

    def test_deploy_jobs_pinned_exactly(self):
        # Every line of both deploy jobs (comments aside): step list, uses, with, run, env.
        # Any change (extra step, other deploy command, --image, shell:, ref:) fails here.
        want = {
            "deploy-web": EXPECTED_DEPLOY_WEB,
            "deploy-worker": EXPECTED_DEPLOY_WORKER,
        }
        for j, lines in want.items():
            with self.subTest(job=j):
                self.assertEqual([l.strip() for l in self._code_lines(self.jobs[j])], lines)

    def test_uses_pinned_to_full_sha(self):
        for m in re.finditer(r"uses:\s*([^\s#]+)", self.text):
            ref = m.group(1)
            if ref.startswith("./"):
                continue
            with self.subTest(uses=ref):
                self.assertRegex(ref, r"@[0-9a-f]{40}$")

    def test_npx_packages_pinned_to_exact_version(self):
        # #465 F2: every npx call names an exact x.y.z version (no bare package, no
        # @latest/@^/@~ ranges), so a deploy never runs an unreviewed CLI with the token.
        code = "\n".join(l for l in self.text.splitlines() if not l.lstrip().startswith("#"))
        calls = re.findall(r"\bnpx\s+((?:-\S+\s+)*)(\S+)", code)
        self.assertTrue(calls, "expected at least one npx call (the Vercel deploy)")
        for flags, pkg in calls:
            with self.subTest(npx=pkg):
                self.assertEqual(flags, "")
                self.assertRegex(pkg, r"^(@[a-z0-9._-]+/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+$")

    def test_vercel_cli_version_pinned(self):
        code = "\n".join(l for l in self.text.splitlines() if not l.lstrip().startswith("#"))
        self.assertIn('run: npx vercel@66.6.0 deploy --prod --token="$VERCEL_TOKEN"', code)
        self.assertNotRegex(code, r"\bnpx\s+vercel(?!@[0-9])")


# --- PR445 R2 follow-up (A2 step 5 prep): quoted/spaced keys + column-0 comments ---

_WEB_IF = "    if: ${{ inputs.gate_only != true && (inputs.target == 'all' || inputs.target == 'web') }}\n"
_WORKER_ENV = "    environment: production\n    permissions:\n      contents: read\n    steps:\n" \
              "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n" \
              "        with:\n          persist-credentials: false\n      - uses: superfly"
_CHECK_STEP = "      - name: Require main CI green on the deployed SHA\n"
_SNEAKY_JOB = ("  deploy-sneaky:\n    runs-on: ubuntu-latest\n    env:\n"
               "      FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}\n    steps:\n"
               "      - run: flyctl deploy --remote-only\n")

# (label, old, new, expected violation substring); old=None appends `new` to the file.
STRUCTURE_MUTANTS = [
    ("needs quoted + retargeted", "    needs: ci-green-gate\n", '    "needs": ruleset-drift\n', "needs"),
    ("needs dropped", "    needs: ci-green-gate\n", "", "needs None"),
    ("needs list without gate", "    needs: ci-green-gate\n", "    needs: [ruleset-drift]\n", "needs"),
    ("if quoted always()", _WEB_IF, "    'if': ${{ always() }}\n", "status function"),
    ("if bare failure()", _WEB_IF, "    if: ${{ failure() || inputs.target == 'web' }}\n", "status function"),
    ("if quoted !cancelled()", _WEB_IF, "    \"if\": ${{ !cancelled() }}\n", "status function"),
    ("environment quoted staging", _WORKER_ENV, _WORKER_ENV.replace("    environment: production",
                                                                    '    "environment": staging'), "environment"),
    ("environment dropped", _WORKER_ENV, _WORKER_ENV.replace("    environment: production\n", ""), "environment None"),
    ("environment spaced key", "    environment: production\n", "    environment : production\n", "spelling"),
    ("gate step quoted if: false", _CHECK_STEP, _CHECK_STEP + '        "if": false\n', "step 2 keys ['if']"),
    ("gate step quoted shell", _CHECK_STEP, _CHECK_STEP + '        "shell": echo {0}\n', "step 2 keys ['shell']"),
    ("gate step spaced shell", _CHECK_STEP, _CHECK_STEP + "        shell : echo {0}\n", "step 2 keys ['shell']"),
    ("gate quoted container", "    timeout-minutes: 5\n", '    timeout-minutes: 5\n    "container": alpine:3\n',
     "job keys"),
    ("gate quoted env BASH_ENV", "    timeout-minutes: 5\n",
     "    timeout-minutes: 5\n    'env':\n      BASH_ENV: scripts/x.sh\n", "job keys"),
    ("column-0 comment, then ungated job", None, "# column-0 comment inside jobs:\n" + _SNEAKY_JOB, "deploy-sneaky"),
    ("blank + bare column-0 #, then ungated job", None, "\n#\n" + _SNEAKY_JOB, "deploy-sneaky"),
    ("flow-style job", None, "  deploy-flow: {runs-on: ubuntu-latest}\n", "unparseable"),
    ("anchor/alias", "  deploy-worker:\n", "  deploy-worker: &w\n", "unparseable"),
    ("duplicate if key", _WEB_IF, _WEB_IF + "    if: ${{ always() }}\n", "duplicate"),
    # PR450 R1 fable B1: double-quoted escapes spelling a status function.
    ("if dq \\x escape", _WEB_IF, '    if: "${{ al\\x77ays() }}"\n', "backslash escape"),
    ("if dq \\u escape", _WEB_IF, '    if: "${{ \\u0066ailure() }}"\n', "backslash escape"),
    ("if dq \\U escape", _WEB_IF, '    if: "${{ always\\U00000028) }}"\n', "backslash escape"),
    ("needs dq escape", "    needs: ci-green-gate\n", '    needs: "ci-green-gat\\x65"\n', "backslash escape"),
    ("secret via dq escape", "VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}",
     'VERCEL_ORG_ID: "${{ secrets\\x2eFLY_API_TOKEN }}"', "backslash escape"),
    # PR450 R1 fable B2: one row per rule of deploy_structure_violations, each `want`
    # unique to that rule's message.
    ("if success()", _WEB_IF, "    if: ${{ success() && inputs.target == 'web' }}\n", "has a status function"),
    ("if needs.* result", _WEB_IF, "    if: ${{ needs.ci-green-gate.result != 'x' }}\n", "has a status function"),
    ("if upper-case Always()", _WEB_IF, "    if: ${{ Always() }}\n", "has a status function"),
    ("if dropped", _WEB_IF, "", "deploy-web: if None missing"),
    ("if literal true (R1 sonnet note)", _WEB_IF, "    if: true\n", "runs with gate_only=true"),
    ("if gate_only clause dropped", _WEB_IF,
     "    if: ${{ inputs.target == 'all' || inputs.target == 'web' }}\n", "runs with gate_only=true"),
    ("if other context", _WEB_IF, "    if: ${{ github.ref != '' }}\n", "not evaluable"),
    ("needs gate + drift", "    needs: ci-green-gate\n", "    needs: [ci-green-gate, ruleset-drift]\n",
     "needs ['ci-green-gate', 'ruleset-drift']"),
    ("extra job (job set)", "\n  deploy-web:\n", "\n  deploy-x:\n    runs-on: u\n\n  deploy-web:\n", "job set ["),
    ("extra top-level key", "\njobs:\n", "\nenv:\n  X: '1'\n\njobs:\n", "top-level keys"),
    ("workflow permissions", "\npermissions: {}\n", "\npermissions: write-all\n", "workflow permissions"),
    ("secret in gate job", "          GH_TOKEN: ${{ github.token }}\n          REPO: ${{ github.repository }}\n          SHA",
     "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          REPO: ${{ github.repository }}\n          SHA",
     "ci-green-gate: uses secrets"),
    ("foreign secret in deploy-web", "VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}",
     "VERCEL_ORG_ID: ${{ secrets.FLY_API_TOKEN }}", "deploy-web: secrets"),
    ("toJSON(secrets) in deploy-worker", "FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}",
     "FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}\n          ALL: ${{ toJSON(secrets) }}", "deploy-worker: secrets"),
    ("continue-on-error on deploy job", _WORKER_ENV,
     _WORKER_ENV.replace("    environment: production\n", "    environment: production\n    continue-on-error: true\n"),
     "job key continue-on-error"),
    ("job-level env on deploy job", _WORKER_ENV.replace("superfly", "actions/setup-node"),
     _WORKER_ENV.replace("superfly", "actions/setup-node").replace(
         "    environment: production\n", "    environment: production\n    env:\n      X: '1'\n"),
     "job key env"),
]


class DeployWorkflowStructure(unittest.TestCase):
    """Spelling-independent checks: a parsed view of deploy.yml, plus column-0 comments."""

    @classmethod
    def setUpClass(cls):
        cls.text = DEPLOY_YML.read_text(encoding="utf-8")

    def test_real_file_has_no_structure_violations(self):
        self.assertEqual(deploy_structure_violations(self.text), [])

    def test_parsed_view_matches_textual_split(self):
        # The two views must agree on the real file, so neither can drift silently.
        tree, spellings = yaml_subset_load(self.text)
        self.assertEqual(spellings, [])
        self.assertEqual(list(tree["jobs"]), list(_jobs_block(self.text)))
        self.assertEqual(list(tree["on"]["workflow_dispatch"]["inputs"]), ["target", "gate_only"])
        for j, tgt in (("deploy-web", "web"), ("deploy-worker", "worker")):
            with self.subTest(job=j):
                job = tree["jobs"][j]
                self.assertEqual(job["needs"], "ci-green-gate")
                self.assertEqual(job["environment"], "production")
                self.assertEqual(job["if"], "${{ inputs.gate_only != true && "
                                            f"(inputs.target == 'all' || inputs.target == '{tgt}') }}}}")
        steps = tree["jobs"]["ci-green-gate"]["steps"]
        self.assertEqual([list(s) for s in steps], [["uses", "with"], ["name", "env", "run"], ["name", "env", "run"]])
        self.assertEqual([l.strip() for l in steps[2]["run"].splitlines() if l.strip()], EXPECTED_CHECK)
        self.assertEqual([l.strip() for l in steps[1]["run"].splitlines() if l.strip()], EXPECTED_FETCH)

    def test_quoted_and_spaced_keys_parse_as_bare_keys(self):
        tree, spellings = yaml_subset_load(
            "jobs:\n  d:\n    \"needs\": ci-green-gate\n    'if': ${{ always() }}\n"
            "    environment : production\n    steps:\n      - \"run\": x\n        'it''s': y\n")
        d = tree["jobs"]["d"]
        self.assertEqual(d, {"needs": "ci-green-gate", "if": "${{ always() }}", "environment": "production",
                             "steps": [{"run": "x", "it's": "y"}]})
        self.assertEqual([s for _, s in spellings], ['"needs"', "'if'", "environment ", '"run"', "'it''s'"])

    def test_textual_probe_misses_quoted_step_if(self):
        # Pins WHY the parsed check exists: on a quoted-key copy the bare-key regexes of
        # DeployWorkflowWiring see no `if:` at all, while the parsed view does.
        mutated = self.text.replace(_CHECK_STEP, _CHECK_STEP + '        "if": false\n', 1)
        gate_body = _jobs_block(mutated)["ci-green-gate"]
        self.assertNotIn("\n        if:", gate_body)  # the textual probe is blind to it ...
        self.assertTrue(any("['if']" in x for x in deploy_structure_violations(mutated)))  # ... this is not

    def test_each_structure_mutant_is_caught(self):
        for label, old, new, want in STRUCTURE_MUTANTS:
            with self.subTest(mutant=label):
                if old is None:
                    mutated = self.text + new
                else:
                    self.assertIn(old, self.text)
                    mutated = self.text.replace(old, new, 1)
                self.assertNotEqual(mutated, self.text)
                v = deploy_structure_violations(mutated)
                self.assertTrue(any(want in x for x in v), (want, v))

    def test_jobs_block_does_not_stop_at_column0_comment(self):
        text = ("name: x\njobs:\n  a:\n    runs-on: u\n# column-0 comment between jobs\n  b:\n"
                "    runs-on: u\n#\n\n  c:\n    needs: a\n# trailing\n")
        self.assertEqual(list(_jobs_block(text)), ["a", "b", "c"])
        self.assertEqual(_jobs_block(text)["c"].strip(), "needs: a")
        self.assertEqual(list(yaml_subset_load(text)[0]["jobs"]), ["a", "b", "c"])

    def test_jobs_block_still_stops_at_next_top_level_key(self):
        text = "jobs:\n  a:\n    runs-on: u\n# c\nenv:\n  X: 1\n"
        self.assertEqual(list(_jobs_block(text)), ["a"])
        self.assertEqual(list(yaml_subset_load(text)[0]), ["jobs", "env"])

    def test_column0_comment_then_extra_job_reaches_every_job_check(self):
        mutated = self.text + "# column-0 comment\n" + _SNEAKY_JOB
        jobs = _jobs_block(mutated)
        self.assertIn("deploy-sneaky", jobs)
        self.assertNotEqual(sorted(jobs), sorted(NON_DEPLOY_JOBS + DEPLOY_JOBS))  # test_job_set_is_exact fails
        self.assertIn("FLY_API_TOKEN", jobs["deploy-sneaky"])  # test_secrets_only_in_deploy_jobs fails

    def test_parser_rejects_constructs_outside_the_subset(self):
        for label, text in (
            ("anchor", "a: &x 1\n"), ("alias", "a: *x\n"), ("tag", "a: !!str 1\n"),
            ("merge key", "a:\n  <<: *x\n"), ("flow map", "a: {b: 1}\n"), ("nested flow", "a: [[1]]\n"),
            ("duplicate", "a: 1\na: 2\n"), ("tab indent", "a:\n\tb: 1\n"), ("document", "a: 1\n---\nb: 2\n"),
            ("bad indent", "a:\n    b: 1\n  c: 2\n"), ("plain multiline", "a:\n  just text\n"),
            ("block header", "a: |2\n  x\n"),
            ("dq \\x", 'a: "al\\x77ays()"\n'), ("dq \\u", 'a: "\\u0061"\n'), ("dq \\U", 'a: "\\U00000061"\n'),
            ("dq \\\"", 'a: "x\\"y"\n'), ("dq \\\\", 'a: "x\\\\y"\n'), ("dq key escape", '"\\x69f": 1\n'),
            ("dq multi-line", 'a: "x\n  y"\n'),
        ):
            with self.subTest(case=label), self.assertRaises(YamlSubsetError):
                yaml_subset_load(text)

    def test_parser_basics(self):
        tree, _ = yaml_subset_load(
            "a: 1  # c\nb:\n  - x\n  - 'y # z'\nc:\n- k: v\n  k2: [p, q]\n- plain\n"
            "d: |\n  l1\n\n  # not a comment\n  l2\ne: {}\nf:\n")
        self.assertEqual(tree, {"a": "1", "b": ["x", "y # z"], "c": [{"k": "v", "k2": ["p", "q"]}, "plain"],
                                "d": "l1\n\n# not a comment\nl2\n", "e": {}, "f": None})


if __name__ == "__main__":
    unittest.main()
