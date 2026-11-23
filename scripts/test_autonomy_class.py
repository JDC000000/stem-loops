#!/usr/bin/env python3
"""Fixture tests for scripts/autonomy_class.py and autonomy-class.yml (\u00a711 R1).

Run:  python3 scripts/test_autonomy_class.py      (stdlib unittest, no deps)

Every case runs the REAL lists in .github/autonomy/ through the REAL
classifier. Fixtures are REST-shaped PR bundles (what `collect` produces).
Where the plan names a real file (BillingButton, LoginForm, ...), its real
bytes are read from the repo, so a fixture cannot drift from the file it is
about.

Structure:
  * PositiveControl  — non-vacuity first: a pure component style change and a
                       design note MUST be `auto`. A checker that refuses
                       everything would pass every other test; this fails it.
  * PlanFixtures     — the exact list in plan R1 ("Fixture tests ... prove").
  * Bypass           — rename, symlink, binary, huge diff, path tricks, case
                       variants, Unicode lookalikes, obfuscated content,
                       import laundering, partial file lists, forks.
  * ListParsing      — deny wins; malformed lists fail (and so post human).
  * CollectStub      — the REST half against a stub `gh`: tree modes, head
                       moved, any API failure or truncation -> human.
  * WorkflowStatic   — the workflow file's security properties.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import autonomy_class as ac

LISTS = ac.load_lists(os.path.join(ROOT, ".github", "autonomy"))
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "autonomy-class.yml")

STYLE_CSS = b""".row {\n  display: flex;\n  gap: 12px;\n  padding: 8px 12px;\n}\n"""
STYLE_TSX = b"""import styles from './Pill.module.css';

export function Pill({ label }: { label: string }) {
  return <span className={styles.row}>{label}</span>;
}
"""


def real(path: str) -> bytes:
    with open(os.path.join(ROOT, path), "rb") as f:
        return f.read()


def fe(filename, content=STYLE_TSX, status="modified", **kw):
    d = {
        "filename": filename,
        "status": status,
        "additions": 1,
        "deletions": 1,
        "patch": "@@ -1 +1 @@\n-a\n+b",
        "type": "file",
        "content_b64": (
            base64.b64encode(content).decode() if content is not None else None
        ),
    }
    d.update(kw)
    return d


def bundle(*files, **pr):
    p = {"changed_files": len(files), "head_repo": "o/r", "base_repo": "o/r"}
    p.update(pr)
    return {"pr": p, "files": list(files)}


def run(b, lists=LISTS):
    return ac.classify(lists, b)


def reasons(v):
    return v["pr_reasons"] + [r for f in v["files"] for r in f["reasons"]]


class Base(unittest.TestCase):
    def assertHuman(self, b, *must_contain, lists=LISTS):
        v = run(b, lists)
        self.assertEqual(v["verdict"], "human", json.dumps(v, indent=1))
        rs = " | ".join(reasons(v))
        for frag in must_contain:
            self.assertIn(frag, rs, rs)
        return v

    def assertAuto(self, b, lists=LISTS):
        v = run(b, lists)
        self.assertEqual(v["verdict"], "auto", json.dumps(v, indent=1))
        return v


# -- 1. non-vacuity first -----------------------------------------------------
class PositiveControl(Base):
    def test_pure_component_style_change_is_auto(self):
        self.assertAuto(
            bundle(fe("apps/web/src/components/play/Pill.module.css", STYLE_CSS))
        )

    def test_pure_component_tsx_change_is_auto(self):
        self.assertAuto(bundle(fe("apps/web/src/components/play/Pill.tsx", STYLE_TSX)))

    def test_real_component_one_line_edit_is_auto(self):
        p = "apps/web/src/components/play/PartPills.tsx"
        self.assertAuto(bundle(fe(p, real(p))))

    def test_real_css_module_and_design_note_together_are_auto(self):
        css = "apps/web/src/components/play/Mixer.module.css"
        self.assertAuto(
            bundle(
                fe(css, real(css)),
                fe("docs/design/nav-wrap.md", b"# Nav wrap\n\nWrap at 360px.\n"),
            )
        )

    def test_added_and_renamed_within_allow_are_auto(self):
        self.assertAuto(
            bundle(
                fe("apps/web/src/components/play/New.tsx", status="added"),
                fe(
                    "apps/web/src/components/play/B.tsx",
                    status="renamed",
                    previous_filename="apps/web/src/components/play/A.tsx",
                ),
            )
        )

    def test_safe_imports_are_auto(self):
        src = b"import { x } from '@/lib/play/types';\nimport y from './Sheet';\nimport z from 'react';\n"
        self.assertAuto(bundle(fe("apps/web/src/components/play/X.tsx", src)))


# -- 2. the plan's named fixtures ---------------------------------------------
class PlanFixtures(Base):
    def test_billing_button_one_line_style_edit_denied_by_WHOLE_FILE_content(self):
        p = "apps/web/src/components/BillingButton.tsx"
        v = self.assertHuman(bundle(fe(p, real(p))), "R6 whole-file content")
        # The point of this fixture (C2): the edited line is pure style, so the
        # content hit must come from UNCHANGED lines. Prove it with a path the
        # deny globs don't know, so path rules cannot be what refused it.
        v = self.assertHuman(
            bundle(
                fe(
                    "apps/web/src/components/play/Btn.tsx",
                    real(p),
                    patch="@@\n-  gap: 4px\n+  gap: 6px",
                )
            ),
            "R6",
        )
        self.assertFalse(
            any(r.startswith(("R3", "R4")) for r in reasons(v)), reasons(v)
        )

    def test_login_form(self):
        p = "apps/web/src/components/LoginForm.tsx"
        self.assertHuman(bundle(fe(p, real(p))), "deny **/LoginForm*")

    def test_delete_account_form(self):
        p = "apps/web/src/components/DeleteAccountForm.tsx"
        self.assertHuman(bundle(fe(p, real(p))), "deny **/DeleteAccountForm*")

    def test_json_ld(self):
        p = "apps/web/src/components/seo/JsonLd.tsx"
        self.assertHuman(bundle(fe(p, real(p))), "deny **/JsonLd*")

    def test_reset_password_and_tool_form_by_name(self):
        self.assertHuman(
            bundle(fe("apps/web/src/components/ResetPasswordX.tsx")),
            "deny **/ResetPassword*",
        )
        self.assertHuman(
            bundle(fe("apps/web/src/components/landing/ToolForm.tsx")),
            "deny **/ToolForm*",
        )

    def test_test_file_inside_allowed_dir(self):
        self.assertHuman(
            bundle(fe("apps/web/src/components/__tests__/Pill.test.tsx")),
            "deny **/__tests__/**",
        )
        self.assertHuman(
            bundle(fe("apps/web/src/components/play/Pill.test.tsx")), "deny **/*.test.*"
        )

    def test_privacy_edit(self):
        self.assertHuman(
            bundle(fe("apps/web/src/app/(landing)/privacy/page.tsx")),
            "deny apps/web/src/app/(landing)/privacy/**",
        )

    def test_journey_test(self):
        p = "packages/web-browser-gate/journeys/j11-library.mjs"
        self.assertHuman(bundle(fe(p, real(p))), "deny packages/web-browser-gate/**")

    def test_agent_registry_doc(self):
        self.assertHuman(
            bundle(fe("docs/agent-registry.md", b"# Agents\n")), "deny docs/agent*"
        )

    def test_claude_agent_definition(self):
        self.assertHuman(
            bundle(fe(".claude/agents/x.md", b"# agent\n")), "deny **/.claude/**"
        )

    def test_other_seeded_denies(self):
        for p, g in [
            (".github/workflows/ci.yml", ".github/**"),
            (".github/autonomy/allow.txt", ".github/**"),
            (".github/CODEOWNERS", "**/CODEOWNERS"),
            ("AGENTS.md", "**/AGENTS.md"),
            ("CLAUDE.md", "**/CLAUDE.md"),
            ("apps/web/CLAUDE.local.md", "**/CLAUDE.local.md"),
            ("apps/web/src/components/SKILL.md", "**/SKILL.md"),
            (".mcp.json", "**/.mcp.json"),
            ("scripts/autonomy_class.py", "scripts/**"),
            (".env.local", "**/.env*"),
            ("apps/worker/migrations/040_x.sql", "**/migrations/**"),
            ("apps/web/src/lib/billing/providers/stripe.ts", "**/*stripe*"),
            ("apps/web/src/app/api/billing/webhook/route.ts", "**/*billing*/**"),
            ("apps/web/src/app/api/entitlements/route.ts", "**/*entitlement*/**"),
            ("apps/web/src/stripe/hooks.ts", "**/*stripe*/**"),
            ("apps/web/src/components/credits/Badge.tsx", "**/*credit*/**"),
            ("apps/web/src/components/session/Badge.tsx", "**/*session*/**"),
            ("apps/web/src/app/pricing/page.tsx", "**/*pricing*/**"),
            ("apps/web/src/lib/auth/supabase.ts", "**/*auth*/**"),
            ("apps/web/src/middleware.ts", "**/middleware.*"),
            ("apps/web/src/app/layout.tsx", "**/layout.*"),
            ("apps/web/next.config.js", "**/next.config.*"),
            ("package.json", "**/package.json"),
            ("pnpm-lock.yaml", "**/pnpm-lock.yaml"),
            ("apps/worker/src/worker/billing/x.py", "apps/worker/**"),
            ("docs/runbook-restore.md", "**/*runbook*"),
        ]:
            with self.subTest(p=p):
                self.assertHuman(bundle(fe(p, b"x\n")), f"deny {g}")

    def test_content_patterns_named_in_plan(self):
        for snippet in [
            b"const s = 'stripe';",
            b"post('/api/billing/x')",
            b"// checkout",
            b"entitlement",
            b"allowance",
            b"<p>3 credits left</p>",
            b"await fetch(url)",
            b"process.env.X",
            b"<div dangerouslySetInnerHTML={{__html: x}} />",
            b"// [billing]",
            b"SELECT * FROM jobs",
            b"service_role",
            b"eval('1')",
            b"import cp from 'child_process'",
        ]:
            with self.subTest(snippet=snippet):
                body = b"export const A = 1;\n" + snippet + b"\n"
                self.assertHuman(
                    bundle(fe("apps/web/src/components/play/X.tsx", body)), "R6"
                )


# -- 3. bypass attempts -------------------------------------------------------
class Bypass(Base):
    C = "apps/web/src/components/play/"

    # renames / copies
    def test_rename_from_denied_into_allowed(self):
        self.assertHuman(
            bundle(
                fe(
                    self.C + "settings.tsx",
                    status="renamed",
                    previous_filename=".claude/settings.json",
                )
            ),
            "R3 .claude/settings.json",
        )

    def test_rename_from_unallowed_into_allowed(self):
        self.assertHuman(
            bundle(
                fe(
                    self.C + "engine.ts",
                    status="renamed",
                    previous_filename="apps/web/src/lib/play/engine.ts",
                )
            ),
            "R4 apps/web/src/lib/play/engine.ts",
        )

    def test_copy_and_mode_change_and_removal_are_human(self):
        self.assertHuman(
            bundle(
                fe(
                    self.C + "A.tsx",
                    status="copied",
                    previous_filename=self.C + "B.tsx",
                )
            ),
            "R2",
        )
        self.assertHuman(bundle(fe(self.C + "A.tsx", status="changed")), "R2")
        self.assertHuman(bundle(fe(self.C + "A.tsx", status="removed")), "R2")
        self.assertHuman(bundle(fe(self.C + "A.tsx", status="weird")), "R2")

    # file objects
    def test_symlink_executable_submodule(self):
        for t in ("symlink", "executable", "submodule", "missing", "mode 100664"):
            with self.subTest(t=t):
                self.assertHuman(
                    bundle(fe(self.C + "A.tsx", b"../../../.env", type=t)), "R5"
                )

    def test_binary_file(self):
        self.assertHuman(
            bundle(fe(self.C + "A.tsx", b"\x89PNG\r\n\x1a\n\x00\xff", patch=None)), "R5"
        )
        self.assertHuman(
            bundle(fe(self.C + "A.tsx", b"ok\x00nul")), "control character U+0000"
        )
        self.assertHuman(
            bundle(fe(self.C + "A.tsx", b"\xff\xfe bad utf8")), "not UTF-8"
        )
        self.assertHuman(
            bundle(fe("docs/design/shot.png", b"\x89PNG", patch=None)), "R4"
        )

    def test_text_file_without_patch_is_human(self):
        # GitHub omits `patch` for binaries AND for very large diffs; the head
        # bytes alone are not enough to trust the change.
        self.assertHuman(
            bundle(fe(self.C + "A.tsx", STYLE_TSX, patch=None)), "no textual patch"
        )

    def test_missing_or_bad_content(self):
        self.assertHuman(
            bundle(fe(self.C + "A.tsx", None)), "head content was not read"
        )
        f = fe(self.C + "A.tsx")
        f["content_b64"] = "!!!not base64"
        self.assertHuman(bundle(f), "not valid base64")

    # sizes
    def test_huge_diff(self):
        self.assertHuman(
            bundle(fe(self.C + "A.tsx", additions=1501, deletions=0)), "changed lines"
        )
        many = [fe(f"{self.C}F{i}.tsx") for i in range(ac.MAX_FILES + 1)]
        self.assertHuman(bundle(*many), "MAX_FILES")
        self.assertHuman(
            bundle(fe(self.C + "A.tsx", b"/*" + b"a" * ac.MAX_FILE_BYTES + b"*/")),
            "bytes",
        )

    def test_partial_empty_or_unreadable_file_list(self):
        self.assertHuman(bundle(fe(self.C + "A.tsx"), changed_files=2), "partial")
        self.assertHuman(bundle(), "empty file list")
        b = bundle(fe(self.C + "A.tsx"))
        b["collect_error"] = "gh api exited 1"
        self.assertHuman(b, "could not read")
        self.assertHuman({"pr": {}, "files": None}, "file list missing")

    def test_fork(self):
        self.assertHuman(bundle(fe(self.C + "A.tsx"), head_repo="evil/r"), "fork")
        self.assertHuman(bundle(fe(self.C + "A.tsx"), head_repo=None), "fork")

    # path tricks
    def test_dot_dot_and_friends(self):
        for p in [
            "apps/web/src/components/../../../../.github/workflows/x.tsx",
            "apps/web/src/components/./A.tsx",
            "apps/web/src/components//A.tsx",
            "/apps/web/src/components/A.tsx",
            "apps\\web\\src\\components\\A.tsx",
            "apps/web/src/components/A .tsx",
            "apps/web/src/components/A\n.tsx",
            "",
            "apps/web/src/components/" + "a" * 300 + ".tsx",
        ]:
            with self.subTest(p=p):
                self.assertHuman(bundle(fe(p)), "R1")

    def test_previous_filename_path_tricks(self):
        self.assertHuman(
            bundle(
                fe(
                    self.C + "A.tsx",
                    status="renamed",
                    previous_filename="apps/web/src/components/../../../CLAUDE.md",
                )
            ),
            "R1",
        )

    def test_case_variants_are_denied_not_allowed(self):
        self.assertHuman(bundle(fe(".CLAUDE/agents/x.md", b"x")), "R3")
        self.assertHuman(bundle(fe("apps/web/src/components/Claude.md", b"x")), "R3")
        self.assertHuman(bundle(fe("apps/web/src/components/agents.MD", b"x")), "R3")
        self.assertHuman(bundle(fe("apps/web/src/components/billingButton.tsx")), "R3")
        # allow is exact-case: a directory spelled differently is not allowed
        self.assertHuman(bundle(fe("apps/web/src/Components/play/A.tsx")), "R4")
        self.assertHuman(bundle(fe("apps/web/src/components/play/A.TSX")), "R4")

    def test_unicode_lookalike_paths(self):
        for p in [
            "apps/web/src/c\u03bfmponents/A.tsx",  # Greek omicron
            ".cl\u0430ude/agents/x.md",  # Cyrillic a
            "apps/web/src/components/A\u200b.tsx",  # zero-width space
            "apps/web/src/components/\uff21.tsx",  # full-width A
        ]:
            with self.subTest(p=p):
                self.assertHuman(bundle(fe(p)), "non-ASCII")

    def test_unallowed_extension_inside_allowed_dir(self):
        for p in ["A.js", "A.mjs", "a.json", "a.svg", "a.css", "a.md"]:
            with self.subTest(p=p):
                self.assertHuman(bundle(fe(self.C + p)), "R4")

    # content obfuscation
    def test_content_obfuscations(self):
        for snippet in [
            "const f = globalThis['fe' + 'tch'];",
            "const f = window['fetch'];",
            "Reflect.apply(x, y, z)",
            "new Function('return 1')",
            "const f = atob('ZmV0Y2g=');",
            "String.fromCharCode(102)",
            "const s = '\\u0066etch';",
            "const s = '\\x66etch';",
            "const m = await import('./x');",
            "const m = require('fs');",
            "const u = 'https://evil.example/collect';",
            "\uff46\uff45\uff54\uff43\uff48(u)",  # full-width fetch( -> NFKC
            "el.innerHTML = x;",
            "<a href='javascript:alert(1)'>x</a>",
            "const s = sql`select 1`;",
            "supabase.rpc('x')",
        ]:
            with self.subTest(snippet=snippet):
                body = ("export const A = 1;\n" + snippet + "\n").encode()
                self.assertHuman(bundle(fe(self.C + "X.tsx", body)), "R6")

    def test_svg_namespace_url_is_not_a_new_host(self):
        body = b'export const I = () => <svg xmlns="http://www.w3.org/2000/svg" />;\n'
        self.assertAuto(bundle(fe(self.C + "Icon.tsx", body)))

    def test_bidi_trojan_source(self):
        body = "const isAdmin = false; /* \u202e } \u2066if (isAdmin)\u2069 \u2066 */\n".encode()
        self.assertHuman(bundle(fe(self.C + "X.tsx", body)), "bidi")

    # imports (C1)
    def test_imports_from_denied_modules(self):
        for line, frag in [
            ("import { x } from '@/lib/billing';", "lib/billing"),
            ("import { x } from '@/lib/billing/credits';", "lib/billing"),
            ("import { x } from '../../lib/billing/index';", "lib/billing"),
            ("import { x } from '@/lib/auth/supabase';", "lib/auth"),
            ("import { x } from '@/lib/jobs/create-link-job';", "lib/jobs"),
            ("import { x } from '@/app/api/billing/checkout/route';", "app/api"),
            ("import { createClient } from '@supabase/ssr';", "@supabase"),
            ("import Stripe from 'stripe';", "stripe"),
            ("import LoginForm from '@/components/LoginForm';", "LoginForm"),
            ("import B from '../BillingButton';", "BillingButton"),
            ("export { x } from '@/lib/auth/types';", "lib/auth"),
            ("import '@/lib/billing/index';", "lib/billing"),
            ("import fs from 'node:fs';", "node:"),
            ("import { headers } from 'next/headers';", "next/headers"),
        ]:
            with self.subTest(line=line):
                body = (line + "\nexport const A = 1;\n").encode()
                self.assertHuman(bundle(fe(self.C + "X.tsx", body)), "R7", frag)

    def test_css_import(self):
        body = b"@import '../../lib/billing/x.css';\n.a { color: red; }\n"
        self.assertHuman(bundle(fe(self.C + "X.module.css", body)), "R7")

    def test_import_escaping_repo_or_unresolvable(self):
        body = b"import x from '../../../../../../etc/passwd';\n"
        self.assertHuman(bundle(fe(self.C + "X.tsx", body)), "escapes the repo")
        body = b"import x from '/abs/path';\n"
        self.assertHuman(bundle(fe(self.C + "X.tsx", body)), "unresolvable")

    def test_import_rule_applies_even_when_content_rules_are_quiet(self):
        # No content pattern fires on this file; only the import rule can.
        body = b"import { rules } from '@/lib/auth/password-rules';\nexport const A = rules;\n"
        v = self.assertHuman(bundle(fe(self.C + "X.tsx", body)), "R7")
        self.assertFalse(any(r.startswith("R6") for r in reasons(v)), reasons(v))

    def test_one_bad_file_makes_whole_pr_human(self):
        self.assertHuman(
            bundle(fe(self.C + "Ok.tsx"), fe("AGENTS.md", b"x")), "R3 AGENTS.md"
        )


# -- 4. lists -----------------------------------------------------------------
class ListParsing(Base):
    def test_deny_wins_over_allow(self):
        L = ac.parse_lists("apps/**\n", "apps/secret/**\n")
        self.assertAuto(bundle(fe("apps/ok/A.tsx")), lists=L)
        self.assertHuman(bundle(fe("apps/secret/A.tsx")), "R3", lists=L)

    def test_default_deny(self):
        self.assertHuman(
            bundle(fe("README.md", b"# hi\n")), "R4 README.md is not in allow.txt"
        )

    def test_malformed_lists_fail(self):
        for a, d in [
            ("x/**\n", "bogus: y\n"),
            ("x/**\n", "content: (unclosed\n"),
            ("content: x\n", "y/**\n"),
            ("", "y/**\n"),
            ("x/**\n", ""),
            ("/abs/**\n", "y\n"),
        ]:
            with self.subTest(a=a, d=d), self.assertRaises(ac.ListError):
                ac.parse_lists(a, d)

    def test_glob_semantics(self):
        rx = lambda g: re.compile(ac.glob_to_regex(g))
        self.assertTrue(
            rx("apps/web/src/components/**/*.tsx").fullmatch(
                "apps/web/src/components/A.tsx"
            )
        )
        self.assertTrue(
            rx("apps/web/src/components/**/*.tsx").fullmatch(
                "apps/web/src/components/a/b/A.tsx"
            )
        )
        self.assertFalse(
            rx("apps/web/src/components/**/*.tsx").fullmatch(
                "apps/web/src/componentsX/A.tsx"
            )
        )
        self.assertTrue(rx("CLAUDE.md").fullmatch("a/b/CLAUDE.md"))
        self.assertTrue(rx("scripts/**").fullmatch("scripts/a/b.py"))
        self.assertFalse(rx("scripts/**").fullmatch("apps/scripts/a.py"))
        self.assertFalse(rx("a/*.ts").fullmatch("a/b/c.ts"))

    def test_real_lists_parse(self):
        self.assertGreater(len(LISTS.allow), 0)
        self.assertGreater(len(LISTS.deny_content), 0)
        self.assertGreater(len(LISTS.deny_imports), 0)

    def test_cli_classify_and_error_exit(self):
        with tempfile.TemporaryDirectory() as d:
            bp = os.path.join(d, "b.json")
            with open(bp, "w") as f:
                json.dump(bundle(fe("AGENTS.md", b"x")), f)
            r = subprocess.run(
                [
                    sys.executable,
                    os.path.join(HERE, "autonomy_class.py"),
                    "classify",
                    "--lists",
                    os.path.join(ROOT, ".github", "autonomy"),
                    "--bundle",
                    bp,
                    "--summary-out",
                    os.path.join(d, "s.md"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["verdict"], "human")
            r = subprocess.run(
                [
                    sys.executable,
                    os.path.join(HERE, "autonomy_class.py"),
                    "classify",
                    "--lists",
                    d,
                    "--bundle",
                    bp,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(r.returncode, 2)

    def test_summary_escapes_attacker_text(self):
        v = run(bundle(fe("apps/web/src/components/a|`<img>`.tsx")))
        s = ac.summary_markdown(v)
        self.assertNotIn("<img>", s)
        self.assertNotIn("a|`", s)


# -- 4b. collect() against a stub `gh` (no network) --------------------------
STUB_GH = r"""#!/usr/bin/env python3
import json, os, sys
fx = json.load(open(os.environ["STUB_FIXTURE"]))
args = [a for a in sys.argv[2:] if a != "--paginate"]
if "--jq" in args:
    args = args[: args.index("--jq")]
url = args[0].split("?")[0]
if url in fx["fail"] or url not in fx["routes"]:
    sys.exit(1)
body = fx["routes"][url]
if url.endswith("/files"):
    for x in body:
        print(json.dumps(x))
else:
    print(json.dumps(body))
"""


class CollectStub(Base):
    """The network half, run against a stub `gh` serving REST-shaped JSON."""

    SHA = "a" * 40
    BLOB = "b" * 40
    F = "apps/web/src/components/play/Pill.tsx"

    def _collect(self, routes, fail=()):
        with tempfile.TemporaryDirectory() as d:
            gh = os.path.join(d, "gh")
            with open(gh, "w") as f:
                f.write(STUB_GH)
            os.chmod(gh, 0o755)
            fx = os.path.join(d, "fx.json")
            with open(fx, "w") as f:
                json.dump({"routes": routes, "fail": list(fail)}, f)
            old = dict(os.environ)
            os.environ["PATH"] = d + os.pathsep + old.get("PATH", "")
            os.environ["STUB_FIXTURE"] = fx
            try:
                return ac.collect("o/r", 7, self.SHA)
            finally:
                os.environ.clear()
                os.environ.update(old)

    def _routes(self, mode="100644", head=None):
        return {
            "repos/o/r/pulls/7": {
                "changed_files": 1,
                "head": {"sha": head or self.SHA, "repo": {"full_name": "o/r"}},
                "base": {"repo": {"full_name": "o/r"}},
            },
            "repos/o/r/pulls/7/files": [
                {
                    "filename": self.F,
                    "status": "modified",
                    "additions": 1,
                    "deletions": 1,
                    "patch": "@@ x",
                }
            ],
            f"repos/o/r/git/trees/{self.SHA}": {
                "truncated": False,
                "tree": [{"path": self.F, "mode": mode, "sha": self.BLOB}],
            },
            f"repos/o/r/git/blobs/{self.BLOB}": {
                "encoding": "base64",
                "content": base64.b64encode(STYLE_TSX).decode(),
            },
        }

    def test_collect_then_classify_auto(self):
        self.assertAuto(self._collect(self._routes()))

    def test_symlink_seen_through_tree_mode(self):
        # The contents API would follow a symlink and say "file"; the tree
        # mode does not lie.
        self.assertHuman(self._collect(self._routes(mode="120000")), "symlink")
        self.assertHuman(self._collect(self._routes(mode="100755")), "executable")
        self.assertHuman(self._collect(self._routes(mode="160000")), "submodule")

    def test_head_moved_fails_closed(self):
        self.assertHuman(self._collect(self._routes(head="c" * 40)), "head moved")

    def test_any_api_failure_fails_closed(self):
        for url in (
            "repos/o/r/pulls/7",
            "repos/o/r/pulls/7/files",
            f"repos/o/r/git/trees/{self.SHA}",
            f"repos/o/r/git/blobs/{self.BLOB}",
        ):
            with self.subTest(url=url):
                self.assertHuman(
                    self._collect(self._routes(), fail=[url]), "could not read"
                )

    def test_truncated_tree_fails_closed(self):
        r = self._routes()
        r[f"repos/o/r/git/trees/{self.SHA}"]["truncated"] = True
        self.assertHuman(self._collect(r), "truncated")


# -- 5. the workflow ----------------------------------------------------------
class WorkflowStatic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(WORKFLOW, encoding="utf-8") as f:
            cls.src = f.read()
        cls.code = "\n".join(
            ln for ln in cls.src.splitlines() if not ln.lstrip().startswith("#")
        )

    def test_trigger_is_pull_request_target_only(self):
        on = re.search(r"^on:\n((?:  .*\n)+)", self.code, re.MULTILINE).group(1)
        self.assertIn("pull_request_target:", on)
        self.assertNotRegex(
            on, r"^\s+(pull_request|push|workflow_run|workflow_dispatch):", on
        )

    def test_minimal_permissions(self):
        perms = re.search(
            r"^permissions:\n((?:  .*\n)+)", self.code, re.MULTILINE
        ).group(1)
        got = dict(re.findall(r"^\s+([a-z-]+):\s*(\w+)", perms, re.MULTILINE))
        self.assertEqual(
            got, {"checks": "write", "contents": "read", "pull-requests": "read"}
        )
        self.assertEqual(self.code.count("permissions:"), 1, "no job-level widening")

    def test_every_uses_is_sha_pinned(self):
        uses = re.findall(r"uses:\s*(\S+)", self.code)
        self.assertTrue(uses)
        for u in uses:
            self.assertRegex(u, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$", u)

    def test_checks_out_base_only_without_credentials(self):
        self.assertIn("ref: ${{ github.event.pull_request.base.sha }}", self.code)
        self.assertIn("persist-credentials: false", self.code)
        for bad in ("head.ref", "head.repo", "merge_commit_sha", "refs/pull"):
            self.assertNotIn(bad, self.code, bad)

    def test_no_pr_text_interpolated_into_run_scripts(self):
        # ${{ }} may only appear in `with:`/`env:` values, never inside run: blocks.
        in_run = False
        for ln in self.code.splitlines():
            s = ln.strip()
            if s.startswith("run:"):
                in_run = True
                continue
            if (
                in_run
                and re.match(r"^\s{6,8}(- |[a-z-]+:)", ln)
                and not ln.startswith(" " * 10)
            ):
                in_run = False
            if in_run:
                self.assertNotIn("${{", ln, ln)

    def test_runs_only_base_checker_and_posts_named_check(self):
        self.assertIn("python3 scripts/autonomy_class.py collect", self.code)
        self.assertIn("--lists .github/autonomy", self.code)
        self.assertIn('name: "autonomy-class"', self.code)
        self.assertIn("if: always()", self.code)
        self.assertNotRegex(self.code, r"\b(npm|pnpm|yarn|pip)\b")
        self.assertNotIn("labels", self.code)
        self.assertNotIn("/merge", self.code)

    def test_fails_closed_to_neutral_human(self):
        self.assertRegex(
            self.code,
            r'if \[ "\$VERDICT" = "auto" \]; then\s+conclusion=success; title=auto\s+else\s+conclusion=neutral; title=human',
        )


if __name__ == "__main__":
    unittest.main(verbosity=1)
