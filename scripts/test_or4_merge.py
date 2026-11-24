"""Offline tests for scripts/or4-merge.sh (gate v3.4): protected-path regex, overlap guard, verdict-marker parsing.

The script is sourced with OR4_LIB=1, which defines PROTECTED_RE / marker_ok and returns before
touching gh or git, so the tests use the script's own single definitions (no copy to drift).
Run: python3 -m unittest scripts/test_or4_merge.py   (or: python3 scripts/test_or4_merge.py)
"""
import os
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "or4-merge.sh")
SHA = "0123456789abcdef0123456789abcdef01234567"

PROTECTED = [
    ".github/workflows/ci.yml", ".github/CODEOWNERS", "scripts/or4-merge.sh", "scripts/lib/smoke_session.mjs",
    "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".claude/settings.json",
    "apps/web/.claude/commands/x.md", "docs/skills/foo/SKILL.md", "CODEOWNERS",
    "apps/worker/migrations/034_v3_pricing_model_truth.sql", "migrations/001.sql", ".env", ".env.local",
    "apps/web/.env.production", "apps/web/src/lib/billing/plans.ts", "apps/web/src/app/api/stripe/webhook/route.ts",
    "apps/web/src/lib/entitlement.ts", "apps/web/src/lib/stripe.ts", "apps/web/src/lib/auth/session.ts", "apps/web/src/auth.ts",
    "apps/x/CLAUDE.md", "docs/CLAUDE.md", "apps/x/CLAUDE.local.md", "apps/x/AGENTS.md", "apps/x/.mcp.json",
    "APPS/X/claude.md", "apps/web/src/middleware.ts", "apps/web/src/lib/oauth.ts", "apps/web/src/lib/authz.ts",
    "apps/web/test/webhook-handler.test.ts",
    "apps/worker/src/worker/service_role.py", "apps/worker/src/worker/service-role.py", "docs/secrets.md",
]
NOT_PROTECTED = [
    "apps/web/src/components/x/Y.tsx", "docs/design/a.md", "packages/ui/src/b.ts",
    "apps/web/src/app/(app)/library/page.tsx", "README.md", "apps/worker/src/worker/models.py",
]


def sh(code, *args):
    p = subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\n{code}', "bash", *args],
                       capture_output=True, text=True)
    return p


def is_protected(path):
    return sh('printf "%s\\0" "$1" | protected_match | grep -q .', path).returncode == 0


def decision(labels="", title="", prot="", pr="363", **env):
    e = dict(os.environ)
    e.pop("JON_ROW", None)
    e.pop("JON_PR", None)
    e.update(env)
    return subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\nprotected_decision "$@"', "bash",
                           labels, title, prot, pr], capture_output=True, text=True, env=e)


def put(path, body):
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


def git(cwd, *a):
    subprocess.run(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True, capture_output=True)


class ProtectedPaths(unittest.TestCase):
    def test_counts(self):
        self.assertGreaterEqual(len(PROTECTED), 18)
        self.assertGreaterEqual(len(NOT_PROTECTED), 5)

    def test_protected_match(self):
        for p in PROTECTED:
            with self.subTest(p=p):
                self.assertTrue(is_protected(p), p)

    def test_non_protected_do_not_match(self):
        for p in NOT_PROTECTED:
            with self.subTest(p=p):
                self.assertFalse(is_protected(p), p)

    def test_sourcing_has_no_side_effects(self):
        self.assertEqual(sh("true").returncode, 0)


class ProtectedDecision(unittest.TestCase):
    """The gate's actual decision: protected and not validly approved => rc 1."""

    def test_unprotected_passes_without_jon_row(self):
        self.assertEqual(decision(labels="bug", title="fix", prot="").returncode, 0)

    def test_protected_trigger_needs_approval(self):
        for kw in ({"prot": "scripts/x.sh"}, {"labels": "a,needs-jon-approval"}, {"labels": "NEEDS-JON-APPROVAL"},
                   {"title": "[Billing] plans"}):
            with self.subTest(kw=kw):
                self.assertEqual(decision(**kw).returncode, 1)
                self.assertEqual(decision(**kw, JON_ROW="12", JON_PR="363").returncode, 0)

    def test_bad_approval_refused(self):
        for env in ({"JON_ROW": "abc", "JON_PR": "363"}, {"JON_ROW": "", "JON_PR": "363"}, {"JON_ROW": "1x", "JON_PR": "363"},
                    {"JON_ROW": "12"}, {"JON_ROW": "12", "JON_PR": "364"}, {"JON_ROW": "12", "JON_PR": ""},
                    {"JON_PR": "363"}):
            with self.subTest(env=env):
                self.assertEqual(decision(prot="scripts/x.sh", **env).returncode, 1)


def overlap(behind, pr, main, listing=True):
    """Run overlap_decision on NUL-separated lists written to temp files (listing=False: empty main list)."""
    with tempfile.TemporaryDirectory() as d:
        pf, mf = os.path.join(d, "pr"), os.path.join(d, "main")
        put(pf, "".join(p + "\0" for p in pr))
        put(mf, "".join(p + "\0" for p in main) if listing else "")
        return subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\noverlap_decision "$@"', "bash",
                               str(behind), pf, mf], capture_output=True, text=True)


class OverlapGuard(unittest.TestCase):
    def test_forged_origin_main_refused(self):
        """forge.sh (review R2 B1): clone whose origin serves a forged v3/main (= PR's first commit) must not hide scripts/x.sh."""
        with tempfile.TemporaryDirectory() as t:
            wd = os.path.join(t, "w"); os.makedirs(wd); git(wd, "init", "-q", "-b", "v3/main")
            put(os.path.join(wd, "base.txt"), "x\n" * 20); git(wd, "add", "-A"); git(wd, "commit", "-qm", "base")
            base = _git_out(wd, "rev-parse", "HEAD")
            git(wd, "checkout", "-q", "-b", "pr"); os.makedirs(os.path.join(wd, "scripts"))
            put(os.path.join(wd, "scripts/x.sh"), "evil\n"); git(wd, "add", "-A"); git(wd, "commit", "-qm", "c1")
            c1 = _git_out(wd, "rev-parse", "HEAD")
            put(os.path.join(wd, "pr.txt"), "p\n"); git(wd, "add", "-A"); git(wd, "commit", "-qm", "c2")
            head = _git_out(wd, "rev-parse", "HEAD")
            origin, clone = os.path.join(t, "o.git"), os.path.join(t, "c")
            subprocess.run(["git", "init", "-q", "--bare", origin], check=True)
            git(wd, "push", "-q", origin, f"{c1}:refs/heads/v3/main", f"{head}:refs/pull/7/head")
            subprocess.run(["git", "clone", "-q", "--no-local", "file://" + origin, clone], check=True, capture_output=True)
            shim = os.path.join(t, "bin"); os.makedirs(shim)
            put(os.path.join(shim, "gh"), f'''#!/bin/bash
case "$*" in *compare/*) printf '0\\t{base}\\t{base}\\n';; *.head.sha*) echo {head};; *.draft*) echo false;; *labels*) echo;;
 *.title*) echo t;; *total_count*) echo 12;; *check_runs*) echo 0;; */status*) echo 0;; *) exit 1;; esac
''')
            os.chmod(os.path.join(shim, "gh"), 0o755)
            rv = os.path.join(t, "rv.md"); put(rv, f"VERDICT: PASS 95 HEAD {head[:7]}\n")
            env = dict(os.environ, PATH=shim + ":" + os.environ["PATH"], OR4_REPO=clone)
            for k in ("JON_ROW", "JON_PR", "OR4_LIB", "DRY_RUN", "OR4_TEST"):
                env.pop(k, None)
            # test mode: pin catches the forged main even though behind=0
            r = subprocess.run(["bash", SCRIPT, "7", rv, head], capture_output=True, text=True, env=dict(env, DRY_RUN="1", OR4_TEST="1"))
            self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("main moved during gate", r.stdout)
            # real-run path (no DRY_RUN / no OR4_TEST, or only one of them): OR4_REPO refused outright
            for extra in ({}, {"DRY_RUN": "1"}, {"OR4_TEST": "1"}):
                with self.subTest(extra=extra):
                    r = subprocess.run(["bash", SCRIPT, "7", rv, head], capture_output=True, text=True, env=dict(env, **extra))
                    self.assertEqual(r.returncode, 1); self.assertIn("OR4_REPO set outside test mode", r.stdout)
                    self.assertNotIn("merged=", r.stdout)

    def test_not_behind_passes(self):
        self.assertEqual(overlap(0, ["a.ts"], []).returncode, 0)
        self.assertEqual(overlap(0, ["a.ts"], ["a.ts"]).returncode, 0)  # behind 0 => lists irrelevant

    def test_disjoint_passes(self):
        r = overlap(3, ["apps/web/a.ts", "docs/x.md"], ["apps/worker/b.py"])
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(overlap(20, ["a"], ["b"]).returncode, 0)

    def test_overlap_fails(self):
        r = overlap(2, ["apps/web/a.ts", "docs/x.md"], ["docs/x.md", "z"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("overlap/hot file: update-branch first", r.stdout)
        self.assertIn("docs/x.md", r.stdout)

    def test_hot_file_either_side_fails(self):
        hot = ["pnpm-lock.yaml", "apps/web/package-lock.json", "yarn.lock", "apps/worker/uv.lock", "poetry.lock", "Cargo.lock",
               "package.json", "apps/web/package.json", "apps/worker/migrations/035_x.sql", "AGENTS.md", ".github/CODEOWNERS",
               "CODEOWNERS", ".github/workflows/ci.yml", "tsconfig.json", "apps/web/tsconfig.build.json", "apps/web/next.config.mjs",
               "pnpm-workspace.yaml", "APPS/WEB/PACKAGE.JSON",
               "apps/worker/constraints-prod.txt", "apps/worker/requirements.txt", "apps/worker/requirements-dev.txt",
               "apps/worker/pyproject.toml", "apps/training/pyproject.toml", ".npmrc", ".nvmrc", "turbo.json",
               "apps/worker/Dockerfile", "apps/web/Dockerfile.prod", "apps/worker/fly.toml", "docker-compose.yml", "Makefile",
               "apps/web/.eslintrc.json", "packages/types/schema/contract.schema.json", "packages/types/src/generated.ts"]
        for h in hot:
            with self.subTest(h=h, side="pr"):
                self.assertEqual(overlap(1, [h, "ok.ts"], ["other.ts"]).returncode, 1)
            with self.subTest(h=h, side="main"):
                self.assertEqual(overlap(1, ["ok.ts"], ["other.ts", h]).returncode, 1)

    def test_non_hot_lookalikes_pass(self):
        for f in ["docs/package.json.md", "apps/web/src/tsconfig-notes.md", "my-pnpm-lock.yaml.txt", ".github/ISSUE_TEMPLATE/a.md",
                  "apps/web/next-config.ts", "docs/migrations.md", "docs/Makefile.md", "docs/requirements.md", "packages/types/src/other.ts"]:
            with self.subTest(f=f):
                self.assertEqual(overlap(1, [f], ["other.ts"]).returncode, 0, f)

    def test_listing_failure_fails_closed(self):
        self.assertEqual(overlap(2, ["a.ts"], [], listing=False).returncode, 1)
        self.assertEqual(overlap(2, [], ["b.ts"]).returncode, 1)
        for bad in ("", "x", "-1", "1.5"):
            with self.subTest(bad=bad):
                self.assertEqual(overlap(bad, ["a"], ["b"]).returncode, 1)

    def test_stale_cap(self):
        r = overlap(21, ["a.ts"], ["b.ts"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("stale", r.stdout)

    def test_lists_at_most_five_offenders(self):
        r = overlap(1, [f"f{i}.ts" for i in range(9)], [f"f{i}.ts" for i in range(9)])
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.count(".ts"), 5)

    def test_renames_listed_both_sides(self):
        """A rename on main (old+new names listed) collides with a PR edit of the OLD name, and vice versa."""
        with tempfile.TemporaryDirectory() as d:
            git(d, "init", "-q", "-b", "main")
            for rel in ("src/old.ts", "keep.ts"):
                os.makedirs(os.path.dirname(os.path.join(d, rel)) or d, exist_ok=True)
                put(os.path.join(d, rel), "line\n" * 30)
            git(d, "add", "-A"); git(d, "commit", "-qm", "base")
            base = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            git(d, "mv", "src/old.ts", "src/new.ts"); git(d, "commit", "-qam", "rename on main")
            out = os.path.join(d, ".git", "ml")
            r = sh('list_changed "$1" "$2" HEAD "$3" && tr "\\0" "\\n" <"$3"', d, base, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(set(r.stdout.split()), {"src/old.ts", "src/new.ts"})
            self.assertEqual(overlap(1, ["src/old.ts"], ["src/old.ts", "src/new.ts"]).returncode, 1)
            self.assertEqual(overlap(1, ["src/new.ts"], ["src/old.ts", "src/new.ts"]).returncode, 1)
            self.assertEqual(overlap(1, ["keep.ts"], ["src/old.ts", "src/new.ts"]).returncode, 0)


def _git_out(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], check=True, capture_output=True, text=True).stdout.strip()


class GateWiring(unittest.TestCase):
    """End-to-end: the real script (DRY_RUN=1) against a temp origin/clone with a PATH-shimmed gh, so the call-site
    wiring (compare pinning, main-side listing, fail-closed) is exercised, not just overlap_decision."""
    PR = "7"

    def run_gate(self, main_files, behind=None, abase=None, amb=None):
        with tempfile.TemporaryDirectory() as t:
            origin, clone, wd = (os.path.join(t, x) for x in ("origin.git", "clone", "work"))
            os.makedirs(wd); subprocess.run(["git", "init", "-q", "--bare", "-b", "v3/main", origin], check=True)
            git(wd, "init", "-q", "-b", "v3/main")
            put(os.path.join(wd, "base.txt"), "x\n" * 20); git(wd, "add", "-A"); git(wd, "commit", "-qm", "base")
            base = _git_out(wd, "rev-parse", "HEAD")
            git(wd, "checkout", "-q", "-b", "pr"); put(os.path.join(wd, "pr.txt"), "p\n"); git(wd, "add", "-A"); git(wd, "commit", "-qm", "pr")
            head = _git_out(wd, "rev-parse", "HEAD")
            git(wd, "checkout", "-q", "v3/main")
            for f in main_files:
                os.makedirs(os.path.dirname(os.path.join(wd, f)), exist_ok=True)
                put(os.path.join(wd, f), "m\n"); git(wd, "add", "-A"); git(wd, "commit", "-qm", "main " + f)
            main = _git_out(wd, "rev-parse", "HEAD")
            git(wd, "push", "-q", origin, "v3/main:refs/heads/v3/main", f"{head}:refs/pull/{self.PR}/head")
            subprocess.run(["git", "clone", "-q", "--no-local", "file://" + origin, clone], check=True, capture_output=True)
            # the clone is made BEFORE the gate fetches the PR ref, like the real clone
            n = len(main_files) if behind is None else behind
            cmp_out = f"{n}\t{abase or main}\t{amb or base}"
            shim = os.path.join(t, "bin"); os.makedirs(shim)
            put(os.path.join(shim, "gh"), f'''#!/bin/bash
a="$*"
case "$a" in
  *compare/*) printf '%s\\n' "$SHIM_CMP";;
  *.head.sha*) echo "$SHIM_H";;
  *.draft*) echo false;;
  *labels*) echo "";;
  *.title*) echo "t";;
  *total_count*) echo 12;;
  *check_runs*) echo 0;;
  */status*) echo 0;;
  *) echo "unexpected gh $a" >&2; exit 1;;
esac
''')
            os.chmod(os.path.join(shim, "gh"), 0o755)
            rv = os.path.join(t, "review.md"); put(rv, f"VERDICT: PASS 95 HEAD {head[:7]}\n")
            env = dict(os.environ, PATH=shim + ":" + os.environ["PATH"], OR4_REPO=clone, OR4_TEST="1", DRY_RUN="1", SHIM_H=head, SHIM_CMP=cmp_out)
            for k in ("JON_ROW", "JON_PR", "OR4_LIB"):
                env.pop(k, None)
            return subprocess.run(["bash", SCRIPT, self.PR, rv, head], capture_output=True, text=True, env=env), main, base

    def test_disjoint_behind_passes(self):
        r, _, _ = self.run_gate(["m1.txt"])
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout + r.stderr)

    def test_overlap_and_hot_on_main_fail(self):
        for f in ("pr.txt", "package.json", "apps/worker/constraints-prod.txt"):
            with self.subTest(f=f):
                r, _, _ = self.run_gate([f])
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
                self.assertIn("overlap/hot file: update-branch first", r.stdout)

    def test_main_listing_failure_not_swallowed(self):
        # api says behind=1 but local origin/v3/main has nothing since merge-base: empty main listing must FAIL (M12)
        r, main, base = self.run_gate([], behind=1, abase=None, amb=None)
        self.assertEqual(main, base)
        self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)

    def test_main_moved_during_gate_fails(self):
        r, _, _ = self.run_gate(["m1.txt"], abase="0" * 40)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("main moved during gate", r.stdout)
        r, _, _ = self.run_gate(["m1.txt"], amb="1" * 40)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("main moved during gate", r.stdout)

    def test_behind_21_and_garbage_fail(self):
        r, _, _ = self.run_gate(["m1.txt"], behind=21)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("stale", r.stdout)
        r, _, _ = self.run_gate(["m1.txt"], behind="x")
        self.assertIn("DRY_RUN fail=1", r.stdout)

    def test_pin_applies_when_not_behind(self):
        r, _, _ = self.run_gate([], abase="0" * 40)          # behind=0 but local main != api base
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("main moved during gate", r.stdout)
        r, _, _ = self.run_gate([], amb="1" * 40)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("main moved during gate", r.stdout)

    def test_not_behind_passes(self):
        r, _, _ = self.run_gate([])
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout + r.stderr)


class ChangedFiles(unittest.TestCase):
    """B1 regressions in a real temp repo: renames out of protected dirs, non-ASCII names, nested CLAUDE.md."""

    def test_rename_and_unicode_detected(self):
        with tempfile.TemporaryDirectory() as d:
            git(d, "init", "-q", "-b", "main")
            for rel, body in {"apps/worker/migrations/034_x.sql": "select 1;\n" * 20, "CODEOWNERS": "* @a\n" * 20}.items():
                os.makedirs(os.path.dirname(os.path.join(d, rel)) or d, exist_ok=True)
                put(os.path.join(d, rel), body)
            git(d, "add", "-A"); git(d, "commit", "-qm", "base")
            base = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            git(d, "mv", "apps/worker/migrations/034_x.sql", "apps/x_034.sql")
            git(d, "mv", "CODEOWNERS", "docs_owners.txt")
            for rel in (".github/actions/a/\u00e9.yml", ".env.\u00e9", "apps/x/CLAUDE.md"):
                os.makedirs(os.path.dirname(os.path.join(d, rel)) or d, exist_ok=True)
                put(os.path.join(d, rel), "x\n")
            git(d, "add", "-A"); git(d, "commit", "-qm", "pr")
            out = os.path.join(d, ".git", "fl")
            r = sh('list_changed "$1" "$2" HEAD "$3" && protected_match <"$3"', d, base, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            got = set(r.stdout.split("\n"))
            for want in ("apps/worker/migrations/034_x.sql", "CODEOWNERS", ".github/actions/a/\u00e9.yml",
                         ".env.\u00e9", "apps/x/CLAUDE.md"):
                self.assertIn(want, got)

    def test_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            git(d, "init", "-q", "-b", "main")
            put(os.path.join(d, "a"), "x")
            git(d, "add", "-A"); git(d, "commit", "-qm", "base")
            out = os.path.join(d, ".git", "fl")
            self.assertNotEqual(sh('list_changed "$1" HEAD HEAD "$2"', d, out).returncode, 0)   # empty diff
            self.assertNotEqual(sh('list_changed "$1" "" HEAD "$2"', d, out).returncode, 0)     # no merge-base
            self.assertNotEqual(sh('list_changed "$1" deadbeef HEAD "$2"', d, out).returncode, 0)  # git error


class LibMode(unittest.TestCase):
    def test_executed_with_or4_lib_is_not_success(self):
        env = dict(os.environ, OR4_LIB="1")
        p = subprocess.run(["bash", SCRIPT, "363", "/nonexistent", "deadbeef"], capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 2)
        self.assertIn("library mode, NOT a merge", p.stderr)


class MarkerParsing(unittest.TestCase):
    def ok(self, text, reviewed=SHA):
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(text)
        try:
            return sh('marker_ok "$1" "$2"', f.name, reviewed).returncode == 0
        finally:
            os.unlink(f.name)

    def test_pass_91_to_100_accepted(self):
        for n in range(91, 101):
            with self.subTest(n=n):
                self.assertTrue(self.ok(f"notes\nVERDICT: PASS {n} HEAD {SHA[:7]}\n"))
        self.assertTrue(self.ok(f"VERDICT: PASS 95 HEAD {SHA}\n"))

    def test_refused(self):
        bad = {
            "pass 90": f"VERDICT: PASS 90 HEAD {SHA[:7]}\n",
            "pass 101": f"VERDICT: PASS 101 HEAD {SHA[:7]}\n",
            "fail 95": f"VERDICT: FAIL 95 HEAD {SHA[:7]}\n",
            "missing HEAD": "VERDICT: PASS 95\n",
            "short sha": f"VERDICT: PASS 95 HEAD {SHA[:6]}\n",
            "wrong sha prefix": "VERDICT: PASS 95 HEAD fedcba9\n",
            "no marker": f"Verdict: PASS 95 {SHA[:7]}\n",
            "indented": f" VERDICT: PASS 95 HEAD {SHA[:7]}\n",
            "last marker wins": f"VERDICT: PASS 95 HEAD {SHA[:7]}\nVERDICT: FAIL 40 HEAD {SHA[:7]}\n",
        }
        for name, text in bad.items():
            with self.subTest(name=name):
                self.assertFalse(self.ok(text), name)

    def test_missing_file_refused(self):
        self.assertNotEqual(sh('marker_ok /nonexistent/x "$1"', SHA).returncode, 0)


if __name__ == "__main__":
    unittest.main()
