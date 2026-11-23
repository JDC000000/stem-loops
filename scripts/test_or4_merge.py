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
               "pnpm-workspace.yaml", "APPS/WEB/PACKAGE.JSON"]
        for h in hot:
            with self.subTest(h=h, side="pr"):
                self.assertEqual(overlap(1, [h, "ok.ts"], ["other.ts"]).returncode, 1)
            with self.subTest(h=h, side="main"):
                self.assertEqual(overlap(1, ["ok.ts"], ["other.ts", h]).returncode, 1)

    def test_non_hot_lookalikes_pass(self):
        for f in ["docs/package.json.md", "apps/web/src/tsconfig-notes.md", "my-pnpm-lock.yaml.txt", ".github/ISSUE_TEMPLATE/a.md",
                  "apps/web/next-config.ts", "docs/migrations.md"]:
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
