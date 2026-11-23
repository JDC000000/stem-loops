"""Offline tests for scripts/or4-merge.sh (gate v3.3): protected-path regex + verdict-marker parsing.

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
    "apps/web/src/lib/entitlement.ts", "apps/web/src/lib/auth/session.ts", "apps/web/src/auth.ts",
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
    return sh('printf "%s\\n" "$1" | grep -Eiq "$PROTECTED_RE"', path).returncode == 0


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
