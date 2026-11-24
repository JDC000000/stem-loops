"""Offline tests for scripts/or4-merge.sh (gate v3.6.1 = v3.6 + wider MONEY_RE, non-ASCII path = money, strict VERDICT/SCORES counting; v3.6 = v3.5.1 + money class / two protected reviews / merge-tail hardening; v3.5.1 = v3.4 ∪ 19B v3.4-R2 ∪ #384): protected-path regex, behind guard
(ALLOW_BEHIND, protected, <=5, overlap, hot/coupled, main deletions/renames), snapshot pin, pre-PUT main re-check, git env/replace
hardening, OR4_REPO guard, verdict-marker parsing.

The script is sourced with OR4_LIB=1, which defines PROTECTED_RE / marker_ok and returns before
touching gh or git, so the tests use the script's own single definitions (no copy to drift).
Run: python3 -m unittest scripts/test_or4_merge.py   (or: python3 scripts/test_or4_merge.py)
"""
import json
import os
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "or4-merge.sh")
SHA = "0123456789abcdef0123456789abcdef01234567"

MONEY_OK = "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 96\nbody @H\n"
MONEY_OK2 = "VERDICT: PASS 94 HEAD @H\nSCORES: M-9 94 M-11 93\nsecond reviewer @H\n"
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


def overlap(behind, pr, main, listing=True, deleted=(), prot=0, allow=True, del_listing=True, **env):
    """Run overlap_decision on NUL-separated lists written to temp files (listing=False: empty main list;
    del_listing=False: the main-deletions listing is unavailable). allow => ALLOW_BEHIND=1; prot => protected PR."""
    with tempfile.TemporaryDirectory() as d:
        pf, mf, df = os.path.join(d, "pr"), os.path.join(d, "main"), os.path.join(d, "del")
        put(pf, "".join(p + "\0" for p in pr))
        put(mf, "".join(p + "\0" for p in main) if listing else "")
        put(df, "".join(p + "\0" for p in deleted))
        e = {k: v for k, v in os.environ.items() if k not in ("ALLOW_BEHIND", "MAX_BEHIND")}
        if allow:
            e["ALLOW_BEHIND"] = "1"
        e.update(env)
        return subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\noverlap_decision "$@"', "bash",
                               str(behind), pf, mf, df if del_listing else "", str(prot)], capture_output=True, text=True, env=e)


def shim_bin(t, gh_body, log=None):
    """PATH dir with a fake gh (gh_body = bash case arms) and, if log is given, a logging git wrapper."""
    shim = os.path.join(t, "bin"); os.makedirs(shim, exist_ok=True)
    pre = f'echo "gh $*" >>"{log}"\n' if log else ""
    put(os.path.join(shim, "gh"), f'#!/bin/bash\n{pre}a="$*"\ncase "$a" in\n{gh_body}\n  *) echo "unexpected gh $a" >&2; exit 1;;\nesac\n')
    os.chmod(os.path.join(shim, "gh"), 0o755)
    if log:
        real = subprocess.run(["bash", "-c", "command -v git"], capture_output=True, text=True).stdout.strip()
        put(os.path.join(shim, "git"), f'#!/bin/bash\necho "git $*" >>"{log}"\nexec "{real}" "$@"\n')
        os.chmod(os.path.join(shim, "git"), 0o755)
    return shim


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
case "$*" in *branches/*) echo {base};; *compare/*) printf '0\\t{base}\\t{base}\\n';; *.head.sha*) echo {head};; *.draft*) echo false;; *labels*) echo;;
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
            # real-run path (no DRY_RUN / no OR4_TEST, or only one of them): OR4_REPO refused outright, exit 1, and (#384 I1)
            # NO gh or git call at all happens (logging shims), and nothing after the guard runs.
            log = os.path.join(t, "calls.log")
            lshim = shim_bin(os.path.join(t, "l"), "  *) exit 1;;", log=log)
            for extra in ({}, {"DRY_RUN": "1"}, {"OR4_TEST": "1"}):
                with self.subTest(extra=extra):
                    put(log, "")
                    e2 = dict(env, PATH=lshim + ":" + os.environ["PATH"], **extra)
                    r = subprocess.run(["bash", SCRIPT, "7", rv, head], capture_output=True, text=True, env=e2)
                    self.assertEqual(r.returncode, 1, r.stdout); self.assertIn("OR4_REPO set outside test mode", r.stdout)
                    self.assertEqual(r.stdout.strip(), "FAIL: OR4_REPO set outside test mode")
                    self.assertNotIn("merged=", r.stdout)
                    with open(log) as f:
                        self.assertEqual(f.read(), "", "gh/git was called before the OR4_REPO guard exited")

    def test_not_behind_passes(self):
        self.assertEqual(overlap(0, ["a.ts"], []).returncode, 0)
        self.assertEqual(overlap(0, ["a.ts"], ["a.ts"]).returncode, 0)  # behind 0 => lists irrelevant

    def test_disjoint_passes(self):
        r = overlap(3, ["apps/web/a.ts", "docs/x.md"], ["apps/worker/b.py"])
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(overlap(5, ["a"], ["b"]).returncode, 0)   # v3.5: cap 5 (was 20)

    def test_overlap_fails(self):
        r = overlap(2, ["apps/web/a.ts", "docs/x.md"], ["docs/x.md", "z"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("overlap/hot/coupled file: update-branch first", r.stdout)
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
        for f in ["docs/package.json.md", "apps/web/src/tsconfig-notes.md", "my-pnpm-lock.yaml.txt",
                  "apps/web/next-config.ts", "docs/migrations.md", "docs/Makefile.md", "docs/requirements.md", "packages/types/src/other.ts"]:
            with self.subTest(f=f):
                self.assertEqual(overlap(1, [f], ["other.ts"]).returncode, 0, f)
                self.assertEqual(overlap(1, ["other.ts"], [f]).returncode, 0, f)
        # v3.5: .github/** is coupled on the PR side (COUPLED_RE) but non-CI .github files on main are not
        self.assertEqual(overlap(1, ["other.ts"], [".github/ISSUE_TEMPLATE/a.md"]).returncode, 0)
        self.assertEqual(overlap(1, [".github/ISSUE_TEMPLATE/a.md"], ["other.ts"]).returncode, 1)

    def test_listing_failure_fails_closed(self):
        self.assertEqual(overlap(2, ["a.ts"], [], listing=False).returncode, 1)
        self.assertEqual(overlap(2, [], ["b.ts"]).returncode, 1)
        for bad in ("", "x", "-1", "1.5"):
            with self.subTest(bad=bad):
                self.assertEqual(overlap(bad, ["a"], ["b"]).returncode, 1)

    def test_stale_cap(self):
        for n in (6, 21):
            r = overlap(n, ["a.ts"], ["b.ts"])
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
            # v3.5: a disjoint PR still FAILS when main renamed (deleted) a file since the merge-base
            self.assertEqual(overlap(1, ["keep.ts"], ["src/old.ts", "src/new.ts"], deleted=["src/old.ts"]).returncode, 1)
            self.assertEqual(overlap(1, ["keep.ts"], ["src/new2.ts"]).returncode, 0)


def _git_out(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], check=True, capture_output=True, text=True).stdout.strip()


class GateWiring(unittest.TestCase):
    """End-to-end: the real script (DRY_RUN=1) against a temp origin/clone with a PATH-shimmed gh, so the call-site
    wiring (compare pinning, main-side listing, fail-closed) is exercised, not just overlap_decision."""
    PR = "7"

    def run_gate(self, main_files, behind=None, abase=None, amb=None, amain=None, main_rm=(), main_mv=(), labels="",
                 replace=False, real=False, moved=None, title="t", pr_file="pr.txt", review=None, review2=None, **env_extra):
        """main_files: files added on main (one commit each); main_rm: base files deleted on main; main_mv: (old, new) renames.
        env_extra defaults to ALLOW_BEHIND=1; pass ALLOW_BEHIND=None to drop it."""
        with tempfile.TemporaryDirectory() as t:
            origin, clone, wd = (os.path.join(t, x) for x in ("origin.git", "clone", "work"))
            os.makedirs(wd); subprocess.run(["git", "init", "-q", "--bare", "-b", "v3/main", origin], check=True)
            git(wd, "init", "-q", "-b", "v3/main")
            for f in ("base.txt", "old.txt", "gone.txt"):
                put(os.path.join(wd, f), f + "\n" * 20)
            git(wd, "add", "-A"); git(wd, "commit", "-qm", "base")
            base = _git_out(wd, "rev-parse", "HEAD")
            git(wd, "checkout", "-q", "-b", "pr"); (os.makedirs(os.path.dirname(os.path.join(wd, pr_file)), exist_ok=True), put(os.path.join(wd, pr_file), "p\n")); git(wd, "add", "-A"); git(wd, "commit", "-qm", "pr")
            head = _git_out(wd, "rev-parse", "HEAD")
            git(wd, "checkout", "-q", "v3/main")
            for f in main_files:
                os.makedirs(os.path.dirname(os.path.join(wd, f)), exist_ok=True)
                put(os.path.join(wd, f), "m\n"); git(wd, "add", "-A"); git(wd, "commit", "-qm", "main " + f)
            for f in main_rm:
                git(wd, "rm", "-q", f); git(wd, "commit", "-qm", "rm " + f)
            for o, nw in main_mv:
                git(wd, "mv", o, nw); git(wd, "commit", "-qm", "mv " + o)
            main = _git_out(wd, "rev-parse", "HEAD")
            git(wd, "push", "-q", origin, "v3/main:refs/heads/v3/main", f"{head}:refs/pull/{self.PR}/head")
            subprocess.run(["git", "clone", "-q", "--no-local", "file://" + origin, clone], check=True, capture_output=True)
            if replace:   # #384 I2: a replace ref in the clone must FAIL the gate
                git(clone, "replace", base, _git_out(clone, "rev-parse", "origin/v3/main"))
            # the clone is made BEFORE the gate fetches the PR ref, like the real clone
            n = len(main_files) + len(main_rm) + len(main_mv) if behind is None else behind
            cmp_out = f"{n}\t{abase or main}\t{amb or base}"
            put_log = os.path.join(t, "put.log"); cnt = os.path.join(t, "cnt")
            shim = shim_bin(t, '''  *PUT*) echo "$a" >"$SHIM_PUT"; [ -n "$SHIM_PUTFAIL" ] && { echo "HTTP 422 boom" >&2; exit 1; }; echo "${SHIM_PUTOUT-merged=true sha=abc}";;
  *merged_at*) [ -n "$SHIM_MAFAIL" ] && exit 1; echo "${SHIM_MA:-2026-11-23T00:00:00Z JDC000000}";;
  *branches/*) n=$(cat "$SHIM_CNT" 2>/dev/null || echo 0); echo $((n+1)) >"$SHIM_CNT"
    if [ "$n" -ge 1 ] && [ -n "$SHIM_BRERR" ]; then echo "HTTP 502" >&2; exit 1; fi
    if [ "$n" -ge 1 ] && [ -n "$SHIM_MOVED" ]; then echo "$SHIM_MOVED"; else echo "$SHIM_MAIN"; fi;;
  *pulls/[0-9]) [ -n "$SHIM_PRFAIL" ] && { echo "HTTP 500" >&2; exit 1; }; printf '%s\\n' "$SHIM_PRJSON";;
  *compare/*) printf '%s\\n' "$SHIM_CMP";;
  *.head.sha*) echo "$SHIM_H";;
  *.draft*) echo false;;
  *labels*) echo "$SHIM_LABELS";;
  *.title*) echo "${SHIM_TITLE:-t}";;
  *total_count*) echo 12;;
  *check_runs*) echo 0;;
  */status*) echo 0;;''')
            rv = os.path.join(t, "review.md"); put(rv, review if review is not None else f"VERDICT: PASS 95 HEAD {head[:7]}\n")
            rv2 = os.path.join(t, "review2.md")
            if review2 is not None:
                put(rv2, review2.replace("@H", head[:7]))
            if review is not None:
                put(rv, review.replace("@H", head[:7]))
            prjson = json.dumps({"title": title, "labels": [{"name": x} for x in labels.split(",") if x]})
            env = dict(os.environ, PATH=shim + ":" + os.environ["PATH"], OR4_REPO=clone, OR4_TEST="1", DRY_RUN="1", SHIM_H=head,
                       SHIM_CMP=cmp_out, SHIM_MAIN=amain or main, SHIM_LABELS=labels, ALLOW_BEHIND="1",
                       SHIM_PUT=put_log, SHIM_CNT=cnt, SHIM_MOVED=moved or "", SHIM_TITLE=title, SHIM_PRJSON=prjson)
            for k in ("JON_ROW", "JON_PR", "OR4_LIB", "MAX_BEHIND", "MONEY"):
                env.pop(k, None)
            script = SCRIPT
            if real:   # real-merge path: no DRY_RUN/OR4_TEST/OR4_REPO; the hard-coded clone path is swapped for the temp clone in a COPY
                src = open(SCRIPT).read(); old = "REPO=/home/claude/stem-loops"
                self.assertEqual(src.count(old), 1, "REPO default moved: update the test")
                script = os.path.join(t, "or4-copy.sh"); put(script, src.replace(old, f"REPO={clone}"))
                for k in ("DRY_RUN", "OR4_TEST", "OR4_REPO"):
                    env.pop(k, None)
            for k, v in env_extra.items():
                if v is None:
                    env.pop(k, None)
                else:
                    env[k] = v
            r = subprocess.run(["bash", script, self.PR, rv, head] + ([rv2] if review2 is not None else []), capture_output=True, text=True, env=env)
            self.put_args = open(put_log).read() if os.path.exists(put_log) else None
            self.head = head
            return r, main, base

    def test_disjoint_behind_passes(self):
        r, _, _ = self.run_gate(["m1.txt"])
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout + r.stderr)

    def test_overlap_and_hot_on_main_fail(self):
        for f in ("pr.txt", "package.json", "apps/worker/constraints-prod.txt"):
            with self.subTest(f=f):
                r, _, _ = self.run_gate([f])
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
                self.assertIn("overlap/hot/coupled file: update-branch first", r.stdout)

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

    # ---- v3.5.1 (tightening only; #391) ----
    def test_real_merge_put_pins_sha_and_squash(self):
        """M38: the merge PUT carries sha=<head> (and squash); captured from the shimmed gh."""
        r, _, _ = self.run_gate([], real=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIsNotNone(self.put_args, "no merge PUT reached the shim")
        self.assertIn(f"-f sha={self.head}", self.put_args)
        self.assertIn("merge_method=squash", self.put_args)
        self.assertIn(f"pulls/{self.PR}/merge", self.put_args)

    def test_main_moves_before_put_fails_without_put(self):
        """M09: main moves between the snapshot and the pre-PUT re-check: FAIL 'main moved; re-run', exit 1, NO PUT."""
        r, main, _ = self.run_gate([], real=True, moved="9" * 40)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("FAIL: main moved; re-run", r.stdout)
        self.assertIsNone(self.put_args, "PUT happened although main moved")
        self.assertNotIn("merged_at merged_by", r.stdout)

    def test_dry_run_and_allow_behind_strict(self):
        """#391: any value other than unset/0/1 FAILS before ANY gh/git call; unset/0/1 are accepted."""
        for var in ("DRY_RUN", "ALLOW_BEHIND"):
            for bad in ("true", "yes", "TRUE", "2", " 1", "1 ", "", "01", "on"):
                with self.subTest(var=var, bad=bad), tempfile.TemporaryDirectory() as t:
                    log = os.path.join(t, "calls.log"); put(log, "")
                    shim = shim_bin(t, "  *) exit 1;;", log=log)
                    env = dict(os.environ, PATH=shim + ":" + os.environ["PATH"])
                    for k in ("DRY_RUN", "ALLOW_BEHIND", "OR4_REPO", "OR4_TEST", "OR4_LIB"):
                        env.pop(k, None)
                    env[var] = bad
                    r = subprocess.run(["bash", SCRIPT, "7", "/nonexistent/rv.md", SHA], capture_output=True, text=True, env=env)
                    self.assertEqual(r.returncode, 1, r.stdout)
                    self.assertEqual(r.stdout.strip(), f"FAIL: {var} must be 0 or 1")
                    self.assertEqual(open(log).read(), "", "gh/git called before the strict switch check")
        for v in (None, "0", "1"):   # allowed values get past the switch check (PR=x then fails 'PR not numeric', still no network)
            for var in ("DRY_RUN", "ALLOW_BEHIND"):
                with self.subTest(var=var, ok=v):
                    env = dict(os.environ); [env.pop(k, None) for k in ("DRY_RUN", "ALLOW_BEHIND", "OR4_REPO", "OR4_LIB")]
                    if v is not None:
                        env[var] = v
                    r = subprocess.run(["bash", SCRIPT, "x", "/nonexistent/rv.md", SHA], capture_output=True, text=True, env=env)
                    self.assertEqual(r.stdout.strip(), "FAIL: PR not numeric")

    def test_strict_switch_check_precedes_any_command(self):
        with open(SCRIPT) as f:
            body = f.read().split('if [ "${OR4_LIB:-0}" = 1 ]; then', 1)[1]
        self.assertLess(body.index("DRY_RUN must be 0 or 1"), body.index("OR4_REPO set outside test mode"))
        self.assertLess(body.index("ALLOW_BEHIND must be 0 or 1"), body.index("gh api"))
        self.assertLess(body.index("ALLOW_BEHIND must be 0 or 1"), body.index("git -C"))

    def test_gate_text_names_jon_row_ledger(self):
        with open(SCRIPT) as f:
            src = f.read()
        self.assertNotIn("Jon's named approval", src)
        self.assertEqual(src.count("D-6 standing row 95 for self-approved merges, per AGENTS.md M-8"), 2)

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
        r, _, _ = self.run_gate([], ALLOW_BEHIND=None)      # behind 0 needs no ALLOW_BEHIND
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout + r.stderr)

    # ---- v3.5 additions ----
    def test_behind_without_allow_behind_fails(self):
        for v in (None, "0"):
            with self.subTest(v=v):
                r, _, _ = self.run_gate(["m1.txt"], ALLOW_BEHIND=v)
                self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("ALLOW_BEHIND!=1", r.stdout)

    def test_protected_behind_fails_even_with_allow_and_jon_row(self):
        r, _, _ = self.run_gate(["m1.txt"], labels="needs-jon-approval", JON_ROW="12", JON_PR=self.PR)
        self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("protected PR must be up to date", r.stdout)
        self.assertNotIn("FAIL: protected PR needs JON_ROW", r.stdout)       # the approval itself was valid
        r, _, _ = self.run_gate([], labels="needs-jon-approval", JON_ROW="12", JON_PR=self.PR, review=MONEY_OK, review2=MONEY_OK2)   # behind 0: ok
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)

    def test_behind_6_fails_5_passes(self):
        r, _, _ = self.run_gate([f"m{i}.txt" for i in range(6)])
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("behind_by=6 > 5 (stale)", r.stdout)
        r, _, _ = self.run_gate([f"m{i}.txt" for i in range(5)])
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)
        r, _, _ = self.run_gate([f"m{i}.txt" for i in range(5)], MAX_BEHIND="9")    # cannot raise the cap
        self.assertIn("DRY_RUN fail=0", r.stdout)
        r, _, _ = self.run_gate([f"m{i}.txt" for i in range(6)], MAX_BEHIND="9")
        self.assertIn("DRY_RUN fail=1", r.stdout)
        r, _, _ = self.run_gate(["m1.txt", "m2.txt"], MAX_BEHIND="1")             # can lower it
        self.assertIn("DRY_RUN fail=1", r.stdout)

    def test_main_deletion_and_rename_fail(self):
        r, _, _ = self.run_gate([], main_rm=["gone.txt"])
        self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("main deleted/renamed", r.stdout)
        self.assertIn("gone.txt", r.stdout)
        r, _, _ = self.run_gate([], main_mv=[("old.txt", "renamed.txt")])
        self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("main deleted/renamed", r.stdout)
        self.assertIn("old.txt", r.stdout)

    def test_coupled_on_main_fails_exempt_passes(self):
        for f in ("apps/web/vite.config.ts", ".github/actions/x/action.yml", "apps/worker/scripts/seed.py", "scripts/other.sh",
                  "apps/worker/src/worker/models.py", "AGENTS.md", "CODEOWNERS"):
            with self.subTest(f=f):
                r, _, _ = self.run_gate([f])
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
        for f in ("scripts/or4-merge.sh", "scripts/test_or4_merge.py", "docs/x.md", "CLAUDE.md", ".claude/agents/a.md"):
            with self.subTest(f=f):
                r, _, _ = self.run_gate([f])
                self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)

    def test_branch_api_pinned(self):
        r, _, _ = self.run_gate([], amain="2" * 40)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("main moved during gate", r.stdout)

    def test_replace_ref_fails(self):
        r, _, _ = self.run_gate([], replace=True)
        self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("git replace refs present", r.stdout)

    def test_git_env_redirect_neutralised(self):
        with tempfile.TemporaryDirectory() as t:
            bogus = os.path.join(t, "nope")
            r, _, _ = self.run_gate([], GIT_DIR=bogus, GIT_WORK_TREE=bogus, GIT_OBJECT_DIRECTORY=bogus, GIT_INDEX_FILE=bogus,
                                    GIT_COMMON_DIR=bogus, GIT_NAMESPACE="x", GIT_REPLACE_REF_BASE="refs/x/")
            self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout + r.stderr)


# 19B v3.4-R2 harness equivalent (the 52-case file was not attached to #385; cases derived from its rules, run against
# overlap_decision). (name, behind, pr_files, main_files, main_deleted, protected, allow_behind, expected_rc)
R2_CASES = [
    ("b0 no allow", 0, ["a.ts"], [], [], 0, False, 0),
    ("b0 protected", 0, ["scripts/x.sh"], [], [], 1, False, 0),
    ("b0 overlap irrelevant", 0, ["a.ts"], ["a.ts"], [], 0, True, 0),
    ("b1 no allow", 1, ["a.ts"], ["b.ts"], [], 0, False, 1),
    ("b1 allow", 1, ["a.ts"], ["b.ts"], [], 0, True, 0),
    ("b5 allow", 5, ["a.ts"], ["b.ts"], [], 0, True, 0),
    ("b6 allow", 6, ["a.ts"], ["b.ts"], [], 0, True, 1),
    ("b99 allow", 99, ["a.ts"], ["b.ts"], [], 0, True, 1),
    ("b1 protected", 1, ["a.ts"], ["b.ts"], [], 1, True, 1),
    ("b5 protected", 5, ["a.ts"], ["b.ts"], [], 1, True, 1),
    ("b-neg", "-1", ["a.ts"], ["b.ts"], [], 0, True, 1),
    ("b-empty", "", ["a.ts"], ["b.ts"], [], 0, True, 1),
    ("b-float", "2.0", ["a.ts"], ["b.ts"], [], 0, True, 1),
    ("overlap", 2, ["apps/web/a.ts"], ["apps/web/a.ts"], [], 0, True, 1),
    ("overlap case-exact", 2, ["apps/web/A.ts"], ["apps/web/a.ts"], [], 0, True, 0),
    ("main deletion", 1, ["a.ts"], ["gone.ts"], ["gone.ts"], 0, True, 1),
    ("main rename", 1, ["a.ts"], ["old.ts", "new.ts"], ["old.ts"], 0, True, 1),
    ("pr deletion ok", 1, ["dead.ts"], ["b.ts"], [], 0, True, 0),
    ("pr lockfile", 1, ["pnpm-lock.yaml"], ["b.ts"], [], 0, True, 1),
    ("pr workspace", 1, ["pnpm-workspace.yaml"], ["b.ts"], [], 0, True, 1),
    ("pr package.json", 1, ["apps/web/package.json"], ["b.ts"], [], 0, True, 1),
    ("pr .node-version", 1, [".node-version"], ["b.ts"], [], 0, True, 1),
    ("pr .python-version", 1, ["apps/worker/.python-version"], ["b.ts"], [], 0, True, 1),
    ("pr .tool-versions", 1, [".tool-versions"], ["b.ts"], [], 0, True, 1),
    ("pr setup.cfg", 1, ["apps/worker/setup.cfg"], ["b.ts"], [], 0, True, 1),
    ("pr conftest", 1, ["apps/worker/tests/conftest.py"], ["b.ts"], [], 0, True, 1),
    ("pr models.py", 1, ["apps/worker/src/worker/models.py"], ["b.ts"], [], 0, True, 1),
    ("pr generated.ts", 1, ["packages/types/src/generated.ts"], ["b.ts"], [], 0, True, 1),
    ("pr vite config", 1, ["apps/web/vitest.config.mts"], ["b.ts"], [], 0, True, 1),
    ("pr prettierrc", 1, [".prettierrc"], ["b.ts"], [], 0, True, 1),
    ("pr .claude", 1, ["apps/web/.claude/x.md"], ["b.ts"], [], 0, True, 1),
    ("pr CLAUDE substring", 1, ["docs/CLAUDE-notes.md"], ["b.ts"], [], 0, True, 1),
    ("pr scripts/", 1, ["scripts/a.py"], ["b.ts"], [], 0, True, 1),
    ("pr .github/", 1, [".github/ISSUE_TEMPLATE/a.md"], ["b.ts"], [], 0, True, 1),
    ("main lockfile", 1, ["a.ts"], ["pnpm-lock.yaml"], [], 0, True, 1),
    ("main package.json", 1, ["a.ts"], ["packages/ui/package.json"], [], 0, True, 1),
    ("main migration", 1, ["a.ts"], ["apps/worker/migrations/040_x.sql"], [], 0, True, 1),
    ("main workflow", 1, ["a.ts"], [".github/workflows/ci.yml"], [], 0, True, 1),
    ("main composite action", 1, ["a.ts"], [".github/actions/setup/action.yml"], [], 0, True, 1),
    ("main nested scripts py", 1, ["a.ts"], ["apps/web/scripts/gen.mjs"], [], 0, True, 1),
    ("main scripts sh", 1, ["a.ts"], ["scripts/deploy.sh"], [], 0, True, 1),
    ("main conftest", 1, ["a.ts"], ["conftest.py"], [], 0, True, 1),
    ("main config.ts", 1, ["a.ts"], ["apps/web/playwright.config.ts"], [], 0, True, 1),
    ("main eslint", 1, ["a.ts"], [".eslintrc.cjs"], [], 0, True, 1),
    ("main AGENTS (hot, not exempt)", 1, ["a.ts"], ["AGENTS.md"], [], 0, True, 1),
    ("main CODEOWNERS (hot)", 1, ["a.ts"], [".github/CODEOWNERS"], [], 0, True, 1),
    ("main gate script exempt", 1, ["a.ts"], ["scripts/or4-merge.sh"], [], 0, True, 0),
    ("main gate test exempt", 1, ["a.ts"], ["scripts/test_or4_merge.py"], [], 0, True, 0),
    ("main scripts README", 1, ["a.ts"], ["scripts/README-or4.md"], [], 0, True, 0),
    ("main CLAUDE.md", 1, ["a.ts"], ["CLAUDE.md"], [], 0, True, 0),
    ("main .claude/", 1, ["a.ts"], [".claude/agents/x.md"], [], 0, True, 0),
    ("main docs", 1, ["a.ts"], ["docs/agentic/plan.md"], [], 0, True, 0),
    ("main nested gate path not exempt", 1, ["a.ts"], ["apps/scripts/or4-merge.sh"], [], 0, True, 1),
    ("main ISSUE_TEMPLATE", 1, ["a.ts"], [".github/ISSUE_TEMPLATE/bug.md"], [], 0, True, 0),
]


MONEY_PATHS = ["apps/web/src/lib/billing/plans.ts", "apps/web/src/lib/stripe.ts", "apps/web/src/lib/entitlement.ts",
               "apps/web/src/lib/auth/session.ts", "apps/web/src/auth.ts", "apps/web/src/lib/authz.ts", "apps/web/src/lib/oauth.ts",
               "apps/web/src/app/api/stripe/webhook/route.ts", "apps/web/src/app/api/jobs/route.ts", "apps/worker/src/worker/job_admission.py",
               "apps/web/src/lib/admission.ts", "apps/web/src/app/api/uploads/route.ts", "apps/worker/src/worker/retention.py",
               "apps/web/src/lib/spend.ts", "apps/worker/src/worker/replicate_client.py", "apps/worker/src/worker/klangio.py",
               "apps/web/src/lib/pricing.ts", "apps/web/src/lib/pricing-copy.ts", "apps/web/src/lib/credits.ts",
               "apps/web/src/lib/jobs/create-link-job.ts", "apps/web/src/lib/job-access.ts", "apps/web/src/app/api/users/me/claim-jobs/route.ts",
               "apps/web/src/app/api/users/me/trial/consume/route.ts", "apps/worker/tests/test_refund_reaped_jobs.py",
               "apps/web/test/auth-helper.test.mjs", "apps/web/test/auth-callback.test.mjs", "apps/worker/tests/test_fetch_gates_restricted_role.py",
               "apps/web/src/app/api/checkout/route.ts", "apps/web/src/lib/emails/templates/subscription-changed.ts",
               "apps/web/src/lib/emails/templates/plan-ended.ts", "apps/worker/src/worker/cleanup.py", "apps/worker/src/worker/pipeline.py",
               "apps/web/src/app/api/users/me/route.ts", "apps/web/src/lib/r2.ts", "apps/web/src/app/login/page.tsx",
               "apps/web/src/lib/sessions.ts", "apps/worker/src/worker/service_role.py", "docs/secrets.md",
               "apps/worker/db/rls_policies.sql", "apps/worker/db/grants.sql", "apps/web/src/app/api/jobs/create/route.ts"]
NON_MONEY_PATHS = ["apps/web/src/components/x/Y.tsx", "docs/design/a.md", "packages/ui/src/b.ts", "README.md", "scripts/x.sh"]


class Gate36(unittest.TestCase):
    """v3.6 (tightening only): money class, two reviews for protected, merge-tail hardening. Same harness as GateWiring."""
    PR = GateWiring.PR
    run_gate = GateWiring.run_gate
    MONEY_PR = {"pr_file": "apps/web/src/lib/pricing.ts", "JON_ROW": "95", "JON_PR": "7"}   # money path outside PROTECTED_RE; money => protected
    PROT_PR = {"pr_file": "scripts/x.sh", "JON_ROW": "95", "JON_PR": "7"}   # protected path, NOT money
    P1 = "VERDICT: PASS 95 HEAD @H\nbody @H\n"
    P2 = "VERDICT: PASS 94 HEAD @H\nsecond reviewer @H\n"

    def money(self, review, **kw):
        r, _, _ = self.run_gate([], review=review, review2=MONEY_OK2, **{**self.MONEY_PR, **kw})
        return r

    def test_money_path_is_protected_even_outside_protected_re(self):
        for pth in ("apps/web/src/lib/admission.ts", "apps/web/src/lib/pricing-copy.ts"):
            with self.subTest(p=pth):
                self.assertFalse(is_protected(pth), pth)
                kw = dict(pr_file=pth)
                r, _, _ = self.run_gate([], review=MONEY_OK, **kw, JON_ROW="95", JON_PR="7")          # one review
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("needs a SECOND review file", r.stdout)
                r, _, _ = self.run_gate([], review=MONEY_OK, review2=MONEY_OK2, **kw)                  # no JON_ROW
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("protected PR needs JON_ROW", r.stdout)
                r, _, _ = self.run_gate(["m1.txt", "m2.txt"], review=MONEY_OK, review2=MONEY_OK2, **kw, JON_ROW="95", JON_PR="7")  # behind 2, ALLOW_BEHIND=1
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("protected PR must be up to date", r.stdout)
                r, _, _ = self.run_gate([], review=MONEY_OK, review2=MONEY_OK2, **kw, JON_ROW="95", JON_PR="7")
                self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)

    def test_money_re_paths(self):
        for pth in MONEY_PATHS:
            with self.subTest(p=pth):
                self.assertEqual(sh('printf "%s\\0" "$1" | money_paths | grep -q .', pth).returncode, 0, pth)
        for pth in NON_MONEY_PATHS:
            with self.subTest(p=pth):
                self.assertNotEqual(sh('printf "%s\\0" "$1" | money_paths | grep -q .', pth).returncode, 0, pth)

    def test_money_meta_title_and_labels_via_jq(self):
        mm = lambda j: sh('money_meta "$1"', j)
        self.assertEqual(mm('{"title":"[Billing] x","labels":[]}').stdout.strip(), "1")
        self.assertEqual(mm('{"title":"t","labels":[{"name":"a"},{"name":"Needs-Jon-Approval"}]}').stdout.strip(), "0")   # label is protected, not money
        self.assertEqual(mm('{"title":"fix billing, no brackets","labels":[{"name":"bug"}]}').stdout.strip(), "0")
        for bad in ("", "not json", '{"title":1,"labels":[]}', '{"labels":[]}'):
            self.assertNotEqual(mm(bad).returncode, 0, bad)       # unparsable => rc 1 => the gate treats the PR as money

    def test_money_valid_passes(self):
        r = self.money("VERDICT: PASS 93 HEAD @H\nSCORES: M-9 93 M-11 100\nbody\n")
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)
        self.assertIn("money=1", r.stdout)

    def test_money_requires_scores_line2_exact(self):
        bad = {
            "no SCORES": "VERDICT: PASS 95 HEAD @H\nbody\n",
            "SCORES 92": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 92 M-11 95\n",
            "M-11 92": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 92\n",
            "SCORES on line 3": "VERDICT: PASS 95 HEAD @H\nintro\nSCORES: M-9 95 M-11 95\n",
            "SCORES on line 1 only": "SCORES: M-9 95 M-11 95\nVERDICT: PASS 95 HEAD @H\n",
            "table": "VERDICT: PASS 95 HEAD @H\n| M-9 | 95 | M-11 | 95 |\n",
            "free text": "VERDICT: PASS 95 HEAD @H\nM-9 95, M-11 95\n",
            "101": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 101 M-11 95\n",
            "leading zero": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 095 M-11 95\n",
            "decimal": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95.5 M-11 95\n",
            "trailing text": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 95 ok\n",
            "CRLF": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 95\r\n",
            "M-11 first": "VERDICT: PASS 95 HEAD @H\nSCORES: M-11 95 M-9 95\n",
            "marker 92": "VERDICT: PASS 92 HEAD @H\nSCORES: M-9 95 M-11 95\n",
            "marker 91": "VERDICT: PASS 91 HEAD @H\nSCORES: M-9 95 M-11 95\n",
        }
        for name, text in bad.items():
            with self.subTest(name=name):
                r = self.money(text)
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
                self.assertIn("FAIL: money PR", r.stdout, r.stdout)

    def test_non_money_unchanged_needs_no_scores(self):
        r, _, _ = self.run_gate([])
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout); self.assertIn("money=0", r.stdout)

    def test_money_from_title_is_money_but_label_alone_is_not(self):
        r, _, _ = self.run_gate([], review=self.P1, review2=self.P2, JON_ROW="95", JON_PR="7", title="[billing] plans")
        self.assertIn("FAIL: money PR", r.stdout, r.stdout)
        r, _, _ = self.run_gate([], review=MONEY_OK, review2=MONEY_OK2, JON_ROW="95", JON_PR="7", title="[billing] plans")
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)
        r, _, _ = self.run_gate([], review=self.P1, review2=self.P2, JON_ROW="95", JON_PR="7", labels="needs-jon-approval")
        self.assertIn("money=0", r.stdout); self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)    # protected (two reviews) but no SCORES

    def test_money_second_review_also_needs_scores(self):
        r, _, _ = self.run_gate([], review=MONEY_OK, review2=self.P2, JON_ROW="95", JON_PR="7", title="[billing] x")
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("review2.md needs line 1", r.stdout)

    def test_pr_json_unreadable_is_money(self):
        r, _, _ = self.run_gate([], review=self.P1, SHIM_PRJSON="garbage{")
        self.assertIn("money=1", r.stdout); self.assertIn("DRY_RUN fail=1", r.stdout)

    # ---- protected: two reviews ----
    def test_protected_two_distinct_valid_reviews_pass(self):
        r, _, _ = self.run_gate([], review=self.P1, review2=self.P2, **self.PROT_PR)
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)

    def test_protected_one_review_fails(self):
        r, _, _ = self.run_gate([], review=self.P1, **self.PROT_PR)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("needs a SECOND review file", r.stdout)

    def test_protected_identical_reviews_fail(self):
        r, _, _ = self.run_gate([], review=self.P1, review2=self.P1, **self.PROT_PR)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("byte-identical", r.stdout)

    def test_protected_second_review_wrong_sha_fails(self):
        r, _, _ = self.run_gate([], review=self.P1, review2="VERDICT: PASS 94 HEAD fedcba9\nother\n", **self.PROT_PR)
        self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("lacks a valid PASS marker", r.stdout)
        r, _, _ = self.run_gate([], review=self.P1, review2="VERDICT: FAIL 94 HEAD @H\nx @H\n", **self.PROT_PR)
        self.assertIn("DRY_RUN fail=1", r.stdout)
        r, _, _ = self.run_gate([], review=self.P1, review2="VERDICT: PASS 90 HEAD @H\nx @H\n", **self.PROT_PR)
        self.assertIn("DRY_RUN fail=1", r.stdout)

    def test_protected_same_path_or_link_fails(self):
        with tempfile.TemporaryDirectory() as d:
            a, b, c = (os.path.join(d, x) for x in ("a.md", "b.md", "c.md"))
            put(a, f"VERDICT: PASS 95 HEAD {SHA[:7]}\n"); os.link(a, b); put(c, f"VERDICT: PASS 94 HEAD {SHA[:7]}\nx\n")
            call = lambda x, y: sh('review_pair_decision 1 0 "$1" "$2" "$3"', x, y, SHA)
            self.assertEqual(call(a, c).returncode, 0)
            self.assertEqual(call(a, a).returncode, 1)       # same path
            self.assertEqual(call(a, b).returncode, 1)       # hardlink (and identical)
            self.assertEqual(call(a, os.path.join(d, "none")).returncode, 1)

    def test_non_protected_needs_one_review(self):
        r, _, _ = self.run_gate([], review=self.P1)
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)

    # ---- merge tail (#396) ----
    def test_pre_put_recheck_gh_error_fails_closed(self):
        r, _, _ = self.run_gate([], real=True, SHIM_BRERR="1")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("cannot re-read v3/main", r.stdout); self.assertIsNone(self.put_args, "PUT happened")

    def test_put_error_exits_nonzero(self):
        r, _, _ = self.run_gate([], real=True, SHIM_PUTFAIL="1")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("merge PUT failed, NOT merged", r.stdout); self.assertNotIn("merged_at merged_by", r.stdout)

    def test_merged_at_null_after_put_exits_nonzero(self):
        r, _, _ = self.run_gate([], real=True, SHIM_MA="null null")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn("merged_at null", r.stdout)

    def test_merged_at_regetting_error_exits_nonzero(self):
        r, _, _ = self.run_gate([], real=True, SHIM_MAFAIL="1")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn("cannot re-read PR after merge PUT", r.stdout)


    # ---- v3.6 R1 fixes ----
    def test_verdict_must_be_unique_and_line_one(self):
        cases = {
            "FAIL then later PASS": "VERDICT: FAIL 40 HEAD @H\nSCORES: M-9 95 M-11 95\nfix text\nVERDICT: PASS 95 HEAD @H\n",
            "two PASS lines": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 95\nVERDICT: PASS 95 HEAD @H\n",
            "VERDICT not line 1": "notes\nVERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 95\n",
            "mixed-case second verdict": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 95\nVerdict: FAIL 20 (revised)\n",
        }
        for name, text in cases.items():
            with self.subTest(name=name, which="review1 non-protected"):
                r, _, _ = self.run_gate([], review=text)
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("exactly one VERDICT", r.stdout)
            with self.subTest(name=name, which="review2 protected"):
                r, _, _ = self.run_gate([], review=self.P1, review2=text, **self.PROT_PR)
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
            with self.subTest(name=name, which="review1 protected"):
                r, _, _ = self.run_gate([], review=text, review2=self.P2, **self.PROT_PR)
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)

    def test_money_scores_single_line_and_marker_line_ends_at_sha(self):
        for name, text in {
            "second SCORES line": "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 95\nSCORES: M-9 40 M-11 20\n",
            "marker trailing text": "VERDICT: PASS 95 HEAD @H but really FAIL\nSCORES: M-9 95 M-11 95\n",
        }.items():
            with self.subTest(name=name):
                r = self.money(text)
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("FAIL: money PR", r.stdout)

    def test_second_scores_in_review2_fails(self):
        r, _, _ = self.run_gate([], review=MONEY_OK, review2="VERDICT: PASS 94 HEAD @H\nSCORES: M-9 94 M-11 94\nSCORES: M-9 1 M-11 1\n", **self.MONEY_PR)
        self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)

    def test_near_duplicate_reviews_fail(self):
        for name, r2 in {"trailing space": self.P1.replace("\n", "  \n"), "blank lines": self.P1 + "\n\n",
                         "CRLF": self.P1.replace("\n", "\r\n"), "trailing ws line": self.P1 + "   \n"}.items():
            with self.subTest(name=name):
                r, _, _ = self.run_gate([], review=self.P1, review2=r2, **self.PROT_PR)
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
                self.assertIn("identical after whitespace normalisation", r.stdout)
        r, _, _ = self.run_gate([], review=self.P1, review2=self.P1.replace("body", "different words"), **self.PROT_PR)
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)

    def test_money_env_only_raises(self):
        r, _, _ = self.run_gate([], review=self.P1, MONEY="1")                     # non-money PR, MONEY=1: now protected+money
        self.assertIn("money=1", r.stdout); self.assertIn("DRY_RUN fail=1", r.stdout)
        r, _, _ = self.run_gate([], review=MONEY_OK, review2=MONEY_OK2, MONEY="1", JON_ROW="95", JON_PR="7")
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)
        r, _, _ = self.run_gate([], review=self.P1, review2=self.P2, MONEY="0", **{**self.MONEY_PR})   # MONEY=0 cannot lower
        self.assertIn("money=1", r.stdout); self.assertIn("DRY_RUN fail=1", r.stdout)
        for bad in ("2", "true", "", " 1"):
            with self.subTest(bad=bad):
                r, _, _ = self.run_gate([], review=self.P1, MONEY=bad)
                self.assertEqual(r.returncode, 1); self.assertIn("MONEY must be 0 or 1", r.stdout)

    def test_non_utf8_path_cannot_hide(self):
        env = dict(os.environ, LC_ALL="C.UTF-8", LANG="C.UTF-8")
        for fn, path in (("protected_match", b".github/workflows/dep\xffloy.yml"), ("money_paths", b"apps/web/src/billing/caf\xe9.ts")):
            with self.subTest(fn=fn):
                r = subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\n{fn} | grep -aq .'], input=path + b"\0",
                                   capture_output=True, env=env)
                self.assertEqual(r.returncode, 0, r.stderr)

    def test_pr_json_read_failure_fails_closed(self):
        r, _, _ = self.run_gate([], review=self.P1, SHIM_PRFAIL="1")
        self.assertIn("money=1", r.stdout); self.assertIn("DRY_RUN fail=1", r.stdout)

    def test_put_without_merged_true_exits_nonzero(self):
        for out in ("merged=false sha=abc", "sha=abc", ""):
            with self.subTest(out=out):
                r, _, _ = self.run_gate([], real=True, SHIM_PUTOUT=out)
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn("did not report merged=true", r.stdout)
                self.assertNotIn("merged_at merged_by", r.stdout)

    def test_empty_merged_at_exits_nonzero(self):
        r, _, _ = self.run_gate([], real=True, SHIM_MA=" login")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn("merged_at null", r.stdout)

    def test_header_does_not_claim_label_is_money(self):
        with open(SCRIPT) as f:
            head = f.read().split("# v3.5.1 (TIGHTENING", 1)[0]
        self.assertNotIn("or\n#   `needs-jon-approval` label, parsed", head)
        self.assertIn("makes a PR PROTECTED, not money", head)

    def test_real_merge_still_succeeds(self):
        r, _, _ = self.run_gate([], real=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class Gate361(unittest.TestCase):
    """v3.6.1 (tightening only; #406): wider MONEY_RE, non-ASCII path = money, VERDICT/SCORES counted case-insensitively and when indented."""
    PR = GateWiring.PR
    run_gate = GateWiring.run_gate
    MONEY_PR = Gate36.MONEY_PR

    NEW_MONEY = [
        "apps/web/src/app/api/library/remake/route.ts", "apps/web/src/app/api/library/route.ts", "apps/web/src/app/api/library/[entryId]/route.ts",
        "apps/worker/src/worker/reaper.py", "apps/worker/src/worker/consumer.py", "apps/worker/tests/test_reaper_db.py",
        "apps/web/src/lib/stem-urls.ts", "apps/web/src/lib/stem-keys.ts", "apps/web/test/stem-urls-contract.test.mjs",
        "apps/web/src/app/account/page.tsx", "apps/web/src/app/account/delete/page.tsx", "apps/web/src/components/DeleteAccountForm.tsx",
        "apps/web/test/account-portal-button.test.mjs", "apps/web/src/lib/db.ts",
        "apps/worker/src/worker/job_failure.py", "apps/web/src/lib/jobs/retry-policy.ts", "apps/web/test/job-retry.test.mjs",
        "apps/worker/migrations/042_v3_job_allowance_debits.sql", "apps/worker/migrations/013_v3_commercial.sql", "apps/worker/migrations/014_v3_seed_plans.sql",
        "apps/worker/migrations/021_v3_users_deleted_at.sql", "apps/worker/migrations/031_v3_chord_edits_erase_fn.sql", "apps/worker/migrations/001_jobs.sql",
        "apps/worker/src/worker/downloader/fetch_gates.py", "apps/web/src/lib/demo-rate.ts", "apps/web/src/lib/read-rate-limit.ts", "apps/web/src/lib/client-ip.ts",
        "apps/web/src/lib/chords-claim.ts", "apps/web/test/job-page-gate.test.mjs", "apps/web/test/wav-download-gate.test.mjs",
        "apps/web/src/lib/emails/templates/receipt.ts", "apps/web/src/app/success/page.tsx", "apps/web/src/lib/signed-url.ts", "apps/web/src/lib/presign.ts",
        "apps/web/test/library-remake-route.test.mjs", "apps/web/src/lib/remake.ts",
    ]
    STILL_NOT_MONEY = ["apps/web/src/components/library/LibraryList.tsx", "apps/web/src/lib/play/engine.ts", "apps/web/src/lib/seo/meta.ts",
                       "apps/web/src/app/(landing)/page.tsx", "apps/training/model/cqt_plan.py", "docs/notes.md", "apps/web/src/components/chrome/SignedInNav.tsx"]

    def test_new_money_paths(self):
        for pth in self.NEW_MONEY:
            with self.subTest(p=pth):
                self.assertEqual(sh('printf "%s\\0" "$1" | money_paths | grep -q .', pth).returncode, 0, pth)
        for pth in self.STILL_NOT_MONEY:
            with self.subTest(p=pth):
                self.assertNotEqual(sh('printf "%s\\0" "$1" | money_paths | grep -q .', pth).returncode, 0, pth)

    def test_new_money_path_through_gate_needs_two_reviews(self):
        r, _, _ = self.run_gate([], review=MONEY_OK, pr_file="apps/web/src/app/api/library/remake/route.ts", JON_ROW="95", JON_PR="7")
        self.assertIn("money=1", r.stdout); self.assertIn("DRY_RUN fail=1", r.stdout); self.assertIn("needs a SECOND review file", r.stdout)

    def test_non_ascii_path_is_money(self):
        for raw in ("apps/web/src/caf\u00e9.ts", "apps/web/src/\u017ftripe/x.ts", "docs/\u00fc.md"):
            with self.subTest(p=raw):
                # no ASCII money word; only the non-ASCII byte makes it money (also under a UTF-8 locale of the caller)
                env = dict(os.environ, LC_ALL="C.UTF-8", LANG="C.UTF-8")
                r = subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\nmoney_paths | grep -aq .'], input=raw.encode() + b"\0",
                                   capture_output=True, env=env)
                self.assertEqual(r.returncode, 0, r.stderr)
        for raw in (b"x/\x80", b"x/\xff", b"x/a\xc3"):   # raw (non-UTF-8) bytes at both ends of the range
            r = subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\nmoney_paths | grep -aq .'], input=raw + b"\0", capture_output=True)
            self.assertEqual(r.returncode, 0, raw)
        r = subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}" || exit 99\nmoney_paths | grep -aq .'], input=b"apps/web/src/plain.ts\0", capture_output=True)
        self.assertNotEqual(r.returncode, 0)
        r, _, _ = self.run_gate([], review=MONEY_OK, pr_file="apps/web/src/caf\u00e9.ts", JON_ROW="95", JON_PR="7")   # through the gate: money => second review
        self.assertIn("money=1", r.stdout); self.assertIn("needs a SECOND review file", r.stdout)

    def test_later_verdict_or_scores_any_case_or_indented_fails(self):
        base = "VERDICT: PASS 95 HEAD @H\nSCORES: M-9 95 M-11 95\n"
        for name, tail in {
            "indented VERDICT FAIL": "  VERDICT: FAIL 20 HEAD @H\n", "tab-indented verdict": "\tverdict: fail\n", "lowercase verdict": "verdict: FAIL 20\n",
            "indented SCORES": " SCORES: M-9 40 M-11 20\n", "lowercase scores": "scores: M-9 1 M-11 1\n", "mixed-case indented SCORES": "   Scores: M-9 1 M-11 1\n",
        }.items():
            for which in ("review1", "review2"):
                with self.subTest(name=name, which=which):
                    text = base + "notes\n" + tail
                    kw = dict(review=text, review2=MONEY_OK2) if which == "review1" else dict(review=MONEY_OK, review2=text)
                    r, _, _ = self.run_gate([], **kw, **self.MONEY_PR)
                    self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
        # non-money, non-protected: only the VERDICT count applies
        for tail in ("  VERDICT: FAIL 20 HEAD @H\n", "verdict: fail\n"):
            with self.subTest(nonmoney=tail):
                r, _, _ = self.run_gate([], review="VERDICT: PASS 95 HEAD @H\nbody @H\n" + tail)
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout); self.assertIn("exactly one VERDICT", r.stdout)
        r, _, _ = self.run_gate([], review=MONEY_OK, review2=MONEY_OK2, **self.MONEY_PR)    # control: valid pair still passes
        self.assertIn("DRY_RUN fail=0", r.stdout, r.stdout)

    def test_scores_count_is_case_insensitive_unit(self):
        # direct unit test of money_review_ok (kills the "SCORES count case-sensitive" mutant, which survived in v3.6)
        with tempfile.TemporaryDirectory() as t:
            f = os.path.join(t, "r.md")
            for body, rc in (("VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\n", 0),
                             ("VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\nscores: M-9 10 M-11 10\n", 1),
                             ("VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\n  Scores: M-9 10 M-11 10\n", 1)):
                put(f, body)
                self.assertEqual(sh('money_review_ok "$1"', f).returncode, rc, body)
            for body, rc in (("VERDICT: PASS 95 HEAD abcdef0\nx\n", 0), ("VERDICT: PASS 95 HEAD abcdef0\n VERDICT: FAIL 1\n", 1),
                             ("VERDICT: PASS 95 HEAD abcdef0\nverdict: FAIL 1\n", 1)):
                put(f, body)
                self.assertEqual(sh('verdict_unique "$1"', f).returncode, rc, body)

    def test_header_names_v361(self):
        with open(SCRIPT) as f:
            head = "".join(f.readlines()[:8])
        self.assertIn("v3.6.1", head)


class Gate362(unittest.TestCase):
    """v3.6.2 (tightening only; #413): mutant-killers for v3.6.1, three more money paths, reworded VERDICT/SCORES lines fail closed."""
    MONEY_PR = Gate36.MONEY_PR
    run_gate = GateWiring.run_gate
    PR = GateWiring.PR

    def _money(self, pth):
        return sh('printf "%s\\0" "$1" | money_paths | grep -q .', pth).returncode == 0

    def test_money_words_each_alone(self):
        # each path matches ONLY through the named word (kills "drop this word from MONEY_RE")
        for word, pth in {"allowance": "docs/x/allowance.md", "debit": "docs/x/debit.md", "job_attempts": "docs/x/job_attempts.md"}.items():
            with self.subTest(word=word):
                self.assertTrue(self._money(pth), pth)
        self.assertFalse(self._money("docs/x/plain.md"))

    def test_tab_indented_scores_and_verdict_fail(self):
        with tempfile.TemporaryDirectory() as t:
            f = os.path.join(t, "r.md")
            for body, rc in (("VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\n\tSCORES: M-9 10 M-11 10\n", 1),
                             ("VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\n\t\tscores: M-9 10 M-11 10\n", 1)):
                put(f, body)
                self.assertEqual(sh('money_review_ok "$1"', f).returncode, rc, body)
            put(f, "VERDICT: PASS 95 HEAD abcdef0\n\tVERDICT: FAIL 1\n")
            self.assertEqual(sh('verdict_unique "$1"', f).returncode, 1)

    def test_new_money_paths(self):
        for pth in ("apps/web/src/lib/library-server.ts", "apps/web/src/app/jobs/[id]/page.tsx", "apps/web/src/lib/emails/dispatch.ts"):
            with self.subTest(p=pth):
                self.assertTrue(self._money(pth), pth)
        for pth in ("apps/web/src/app/jobs/page.tsx", "apps/web/src/lib/emails/layout.ts", "apps/web/src/lib/library-view.ts"):
            with self.subTest(p=pth):
                self.assertFalse(self._money(pth), pth)

    def test_reworded_markers_fail_closed(self):
        nb = "\u00a0"
        for name, line in {"bold FAIL": "**VERDICT: FAIL**", "bold inner": "**VERDICT**: FAIL", "blockquote": "> VERDICT: FAIL 20", "nested quote": "> > verdict: fail",
                           "NBSP": nb + "VERDICT: FAIL", "NBSP+tab": nb + "\t" + nb + "Verdict: FAIL", "heading": "## VERDICT: FAIL", "backtick": "`VERDICT: FAIL`",
                           "list": "- VERDICT: FAIL", "underscore": "__VERDICT: FAIL__"}.items():
            with self.subTest(name=name):
                with tempfile.TemporaryDirectory() as t:
                    f = os.path.join(t, "r.md")
                    put(f, "VERDICT: PASS 95 HEAD abcdef0\nbody\n" + line + "\n")
                    self.assertEqual(sh('verdict_unique "$1"', f).returncode, 1, line)
                r, _, _ = self.run_gate([], review="VERDICT: PASS 95 HEAD @H\nbody @H\n" + line + "\n")
                self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)
        for name, line in {"bold": "**SCORES: M-9 1 M-11 1**", "bold inner": "**SCORES**: M-9 1 M-11 1", "space colon": "SCORES : M-9 1 M-11 1", "quote": "> SCORES: M-9 1 M-11 1", "NBSP": nb + "SCORES: M-9 1 M-11 1"}.items():
            with self.subTest(scores=name):
                with tempfile.TemporaryDirectory() as t:
                    f = os.path.join(t, "r.md")
                    put(f, "VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\n" + line + "\n")
                    self.assertEqual(sh('money_review_ok "$1"', f).returncode, 1, line)
        # controls: prose without the word-colon shape, and a valid file, still pass
        with tempfile.TemporaryDirectory() as t:
            f = os.path.join(t, "r.md")
            put(f, "VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\nThe verdict was good; scores were high.\n")
            self.assertEqual(sh('verdict_unique "$1"', f).returncode, 0)
            self.assertEqual(sh('money_review_ok "$1"', f).returncode, 0)

    def _unique(self, body):
        with tempfile.TemporaryDirectory() as t:
            f = os.path.join(t, "r.md")
            with open(f, "w", encoding="utf-8", newline="") as fh:
                fh.write(body)
            return sh('verdict_unique "$1"', f).returncode, sh('money_review_ok "$1"', f).returncode

    def test_more_reworded_shapes_fail_closed(self):
        P = "VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\n"
        shapes = {"numbered": "1. VERDICT: FAIL", "numbered paren": "2) VERDICT: FAIL", "checkbox": "- [x] VERDICT: FAIL", "label R1": "R1 VERDICT: FAIL",
                  "label R1 colon": "R1: VERDICT: FAIL", "fullwidth colon": "VERDICT\uff1a FAIL", "dash": "VERDICT - FAIL", "em dash": "VERDICT \u2014 FAIL",
                  "parenthetical": "VERDICT (final): FAIL", "no colon": "VERDICT FAIL", "bare word": "**Verdict**", "ZWSP prefix": "\u200bVERDICT: FAIL",
                  "BOM prefix": "\ufeffverdict: fail", "lone CR": "x\rVERDICT: FAIL", "form feed": "x\fVERDICT: FAIL", "vertical tab": "x\vVERDICT: FAIL",
                  "U+2028": "x\u2028VERDICT: FAIL", "U+2029": "x\u2029VERDICT: FAIL", "NEL": "x\u0085VERDICT: FAIL"}
        for name, line in shapes.items():
            with self.subTest(verdict=name):
                self.assertEqual(self._unique(P + "body\n" + line + "\n")[0], 1, name)
            with self.subTest(scores=name):
                self.assertEqual(self._unique(P + "body\n" + line.replace("VERDICT", "SCORES").replace("Verdict", "Scores").replace("verdict", "scores") + "\n")[1], 1, name)
        # through the whole gate too
        r, _, _ = GateWiring.run_gate(self, [], review="VERDICT: PASS 95 HEAD @H\nbody @H\n1. VERDICT - FAIL\n")
        self.assertIn("DRY_RUN fail=1", r.stdout, r.stdout)

    def test_genuine_files_and_prose_still_pass(self):
        P = "VERDICT: PASS 95 HEAD abcdef0\nSCORES: M-9 95 M-11 95\n"
        for body in (P, P + "The verdict was good; scores were high.\nFinal verdict: PASS\nSee the scoreboard and verdicts.\n", P + "Reviewed 3 files.\n- R1 notes: fine\n"):
            with self.subTest(body=body):
                self.assertEqual(self._unique(body), (0, 0))
        self.assertEqual(self._unique("VERDICT: PASS 95 HEAD abcdef0\nbody\n")[0], 0)

    def test_jobview_and_resend_are_money(self):
        for pth in ("apps/web/src/app/jobs/[id]/JobView.tsx", "apps/web/src/lib/emails/resend.ts"):
            with self.subTest(p=pth):
                self.assertTrue(self._money(pth), pth)
        for pth in ("apps/web/src/app/jobs/[id]/layout.tsx", "apps/web/src/lib/emails/layout.ts", "apps/web/src/app/jobs/JobViewer.tsx"):
            with self.subTest(p=pth):
                self.assertFalse(self._money(pth), pth)

    def test_header_names_v362(self):
        with open(SCRIPT) as f:
            head = "".join(f.readlines()[:20])
        self.assertIn("v3.6.2", head)
        self.assertIn("RESIDUAL", head)
        self.assertIn("never start ANY line", head)


class R2Harness(unittest.TestCase):
    def test_count(self):
        self.assertGreaterEqual(len(R2_CASES), 52)

    def test_cases(self):
        for name, bb, pf, mf, df, prot, allow, want in R2_CASES:
            with self.subTest(name=name):
                r = overlap(bb, pf, mf, deleted=df, prot=prot, allow=allow)
                self.assertEqual(r.returncode, want, f"{name}: {r.stdout}")

    def test_deletion_listing_unavailable_fails_closed(self):
        self.assertEqual(overlap(1, ["a.ts"], ["b.ts"], del_listing=False).returncode, 1)
        self.assertEqual(overlap(0, ["a.ts"], ["b.ts"], del_listing=False).returncode, 0)

    def test_protected_default_is_protected(self):
        """overlap_decision without the protected arg treats the PR as protected (fail closed)."""
        with tempfile.TemporaryDirectory() as d:
            for n in ("p", "m", "d"):
                put(os.path.join(d, n), "a\0" if n == "p" else ("b\0" if n == "m" else ""))
            r = subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}"; overlap_decision 1 "$1/p" "$1/m" "$1/d"', "bash", d],
                               capture_output=True, text=True, env=dict(os.environ, ALLOW_BEHIND="1"))
            self.assertEqual(r.returncode, 1); self.assertIn("protected PR must be up to date", r.stdout)

    def test_is_protected_pr(self):
        for args, want in ((("needs-jon-approval", "t", ""), 0), (("", "[Billing] x", ""), 0), (("", "t", "scripts/x.sh "), 0),
                           (("bug", "fix", ""), 1)):
            with self.subTest(args=args):
                self.assertEqual(sh('is_protected_pr "$@"', *args).returncode, want)


class Hardening(unittest.TestCase):
    """#384 I2 (git env + replace refs) and v3.5 pre-PUT main re-check."""

    def test_git_env_scrubbed_but_auth_env_kept(self):
        env = dict(os.environ, GIT_DIR="/x", GIT_WORK_TREE="/x", GIT_INDEX_FILE="/x", GIT_OBJECT_DIRECTORY="/x",
                   GIT_ALTERNATE_OBJECT_DIRECTORIES="/x", GIT_REPLACE_REF_BASE="refs/x/", GIT_NAMESPACE="x", GIT_COMMON_DIR="/x",
                   GIT_CONFIG_COUNT="1", GIT_ASKPASS="/bin/true", GIT_SSL_CAINFO="/ca")
        r = subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}"; env | grep "^GIT_" | sort'], capture_output=True, text=True, env=env)
        got = dict(line.split("=", 1) for line in r.stdout.split())
        for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                  "GIT_REPLACE_REF_BASE", "GIT_NAMESPACE", "GIT_COMMON_DIR"):
            self.assertNotIn(k, got)
        self.assertEqual(got.get("GIT_NO_REPLACE_OBJECTS"), "1")
        self.assertEqual((got.get("GIT_CONFIG_COUNT"), got.get("GIT_ASKPASS"), got.get("GIT_SSL_CAINFO")), ("1", "/bin/true", "/ca"))

    def test_replace_check(self):
        with tempfile.TemporaryDirectory() as d:
            git(d, "init", "-q", "-b", "main")
            put(os.path.join(d, "a"), "1"); git(d, "add", "-A"); git(d, "commit", "-qm", "1"); c1 = _git_out(d, "rev-parse", "HEAD")
            put(os.path.join(d, "a"), "2"); git(d, "add", "-A"); git(d, "commit", "-qm", "2"); c2 = _git_out(d, "rev-parse", "HEAD")
            self.assertEqual(sh('replace_check "$1"', d).returncode, 0)
            git(d, "replace", c2, c1)
            r = sh('replace_check "$1"', d)
            self.assertEqual(r.returncode, 1); self.assertIn("git replace refs present", r.stdout)
            self.assertEqual(sh('replace_check "$1"', os.path.join(d, "missing")).returncode, 1)   # fail closed

    def test_main_unmoved(self):
        with tempfile.TemporaryDirectory() as t:
            shim = shim_bin(t, '  *branches/v3/main*) echo "$SHIM_MAIN";;')
            env = dict(os.environ, PATH=shim + ":" + os.environ["PATH"], SHIM_MAIN="a" * 40)
            run = lambda pinned: subprocess.run(["bash", "-c", f'OR4_LIB=1 source "{SCRIPT}"; main_unmoved "$1"', "bash", pinned],
                                                capture_output=True, text=True, env=env)
            self.assertEqual(run("a" * 40).returncode, 0)
            r = run("b" * 40)
            self.assertEqual(r.returncode, 1); self.assertIn("main moved; re-run", r.stdout)
            self.assertEqual(run("").returncode, 1)
            env["SHIM_MAIN"] = ""
            self.assertEqual(run("").returncode, 1)          # empty == empty is not "unmoved"

    def test_main_unmoved_runs_immediately_before_put(self):
        with open(SCRIPT) as f:
            lines = [ln for ln in f.read().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        i = next(k for k, ln in enumerate(lines) if "gh api -X PUT" in ln)
        self.assertEqual(lines[i - 1].strip(), 'main_unmoved "$apimain" || exit 1')
        self.assertIn('[ $fail = 0 ] || { echo "NOT MERGED"; exit 1; }', lines[i - 2])

    def test_or4_repo_guard_precedes_any_command(self):
        with open(SCRIPT) as f:
            body = f.read().split('if [ "${OR4_LIB:-0}" = 1 ]; then', 1)[1]
        self.assertLess(body.index("OR4_REPO set outside test mode"), body.index("gh api"))
        self.assertLess(body.index("OR4_REPO set outside test mode"), body.index("git -C"))


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
