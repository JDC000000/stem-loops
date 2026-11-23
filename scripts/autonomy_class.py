#!/usr/bin/env python3
"""Classify a pull request as `auto` or `human` (AGENTIC-L5-PLAN v1.2.1 \u00a72 R1).

WHAT IT DECIDES
---------------
`auto` means: every changed file is in Jon's allow list, none is in his deny
list, no whole-file content pattern fires, no import reaches a denied module,
and the diff is small, textual and fully readable. Everything else is
`human`. The class is an INPUT to the bot merge path (rollback-safe +
adversarial-reviewed + a non-author VERDICT: PASS), never a merge by itself.

Rules, in the order they are reported (all reasons are collected; any one
makes the PR `human`):

  R0  whole-PR shape   base branch is not v3/main; file list unreadable /
                       partial / empty / at the compare cap; head or base
                       moved while reading; more than MAX_FILES files; more
                       than MAX_CHANGED_LINES lines changed; head repo is a
                       fork.
  R1  path hygiene     a path (or a rename's previous path) that is not plain
                       ASCII from a small safe alphabet, or has empty, `.` or
                       `..` segments, a leading `/`, a backslash, or is over
                       MAX_PATH_LEN.  (Unicode lookalikes, `../` tricks.)
  R2  status           only `added`, `modified`, `renamed` can be `auto`.
                       `removed`, `copied`, `changed` (mode change) and
                       anything unknown are `human`.
  R3  deny path        new OR previous path matches deny.txt (case-
                       insensitive).  (Rename out of a denied path.)
  R4  not allowed      new or previous path matches no allow.txt line
                       (case-sensitive).  (Rename into an allowed path from
                       outside it; case variants.)
  R5  file object      head object is not a regular file (symlink,
                       submodule), has no textual patch (binary / too large),
                       is over MAX_FILE_BYTES, is not strict UTF-8, or holds a
                       NUL, a control character or a bidi override.
  R6  content          a deny.txt regex matches the WHOLE head file — not just
                       the changed lines (C2). `content:` lines apply to every
                       file (secrets); `code:` lines only to code files
                       (money, network, execution). Code is scanned raw,
                       comment-stripped and NFKC-normalised.
  R7  import           every import / export-from / side-effect import / CSS
                       @import is canonicalised (no `.`/`..`/empty segments,
                       `?`, `#`, `%`, backslash) and resolved against the
                       head tree in TypeScript order. It is `auto` only if
                       the target is listed in imports-allow.txt or is
                       itself an allowed, non-denied path; a bare package
                       only if listed. deny.txt `import:` wins (C1; review
                       R1 #1-#3).

Lists (allow.txt, deny.txt, imports-allow.txt) are read from the directory
given by --lists; in CI that is a checkout of v3/main
(.github/workflows/autonomy-class.yml), never the PR's.

USAGE
-----
  autonomy_class.py collect --repo O/R --pr N --head-sha SHA --out bundle.json
      Network step: reads the PR, its file list (+ patches) from the
      SHA-pinned compare endpoint, the head tree (modes, paths) and every
      changed file's blob through `gh api` (REST only). Never runs PR code.
      Any read error is recorded in the bundle as `collect_error`, which
      classifies as `human` (fail closed).
  autonomy_class.py classify --lists DIR --bundle bundle.json [--out v.json]
      Pure function of (lists, bundle). Prints the verdict JSON.

Stdlib only. Exit codes (house convention, scripts/_gate_exit.py):
  0 a verdict was computed (auto OR human — read the verdict, not the code)
  2 attempted and failed (bad list file, unreadable bundle, crash)
"""

from __future__ import annotations

import argparse
import base64
import json
import posixpath
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, field

MAX_FILES = 30
MAX_CHANGED_LINES = 1500
MAX_FILE_BYTES = 100_000
MAX_PATH_LEN = 300

AUTO_STATUSES = {"added", "modified", "renamed"}
# Git tree modes. Only a plain non-executable blob can be `auto`.
MODE_TYPES = {
    "100644": "file",
    "100755": "executable",
    "120000": "symlink",
    "160000": "submodule",
    "040000": "dir",
}
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._@()\[\]+-]+$")
JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
CSS_EXTS = (".css",)
CODE_EXTS = JS_EXTS + CSS_EXTS
# Module resolution order (TypeScript/Next bundler): the spec as written, then
# these suffixes. The FIRST one that exists in the head tree is the target.
RESOLVE_SUFFIXES = (
    "",
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".mjs",
    ".cjs",
    ".css",
    "/index.tsx",
    "/index.ts",
    "/index.jsx",
    "/index.js",
)
REQUIRED_BASE_REF = "v3/main"
# Bidi overrides/isolates (Trojan Source) and other controls.
BIDI = set("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f")

# A "gap" between two JS tokens: whitespace and/or comments. `from/**/"x"` and
# `import/**/("x")` are valid syntax (review R1 #2), so every import pattern
# tolerates comments between its tokens, and the text is ALSO scanned with
# comments stripped.
GAP = r"(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*"
IMPORT_RES = [
    re.compile(r"\bfrom" + GAP + r"""(['"`])(.*?)\1"""),
    re.compile(r"\bimport" + GAP + r"""(['"`])(.*?)\1"""),
    re.compile(
        r"@import" + GAP + r"""(?:url\(""" + GAP + r""")?(['"]?)([^'")\s;]+)\1"""
    ),
]
BARE_SPEC = re.compile(
    r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$"
)


class ListError(Exception):
    pass


# -- globs --------------------------------------------------------------------
def glob_to_regex(pat: str) -> str:
    """`**` any segments (incl. none), `*` within a segment, `?` one char.
    No `/` in the pattern -> basename match at any depth."""
    pat = pat.strip()
    if not pat or pat.startswith("/"):
        raise ListError(f"bad glob {pat!r}")
    if pat.endswith("/"):
        pat += "**"
    anchored = "/" in pat
    out = []
    i = 0
    while i < len(pat):
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("/**", i) and i + 3 == len(pat):
            out.append("(?:/.*)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif pat[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pat[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    body = "".join(out)
    return body if anchored else "(?:.*/)?" + body


@dataclass
class Lists:
    allow: list = field(default_factory=list)  # (glob, compiled)
    deny_paths: list = field(default_factory=list)
    # (source line, compiled, scope) scope: "all" = every file, "code" = CODE_EXTS
    deny_content: list = field(default_factory=list)
    deny_imports: list = field(default_factory=list)
    import_allow: set = field(default_factory=set)  # exact repo paths / package names


PREFIX = re.compile(r"^([a-z][a-z-]*):\s+(.*)$")
CONTENT_PREFIXES = {
    "content": ("all", re.IGNORECASE),
    "content-cs": ("all", 0),
    "code": ("code", re.IGNORECASE),
    "code-cs": ("code", 0),
}


def _lines(text: str):
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line and not line.startswith("#"):
            yield n, line


def parse_lists(allow_text: str, deny_text: str, imports_allow_text: str = "") -> Lists:
    L = Lists()
    for n, line in _lines(allow_text):
        if PREFIX.match(line):
            raise ListError(f"allow.txt:{n}: prefixed lines are not allowed here")
        L.allow.append((line, re.compile(glob_to_regex(line))))
    for n, line in _lines(deny_text):
        m = PREFIX.match(line)
        try:
            if not m:
                L.deny_paths.append(
                    (line, re.compile(glob_to_regex(line), re.IGNORECASE))
                )
            elif m.group(1) in CONTENT_PREFIXES:
                scope, flags = CONTENT_PREFIXES[m.group(1)]
                L.deny_content.append((line, re.compile(m.group(2), flags), scope))
            elif m.group(1) == "import":
                L.deny_imports.append(
                    (m.group(2), re.compile(glob_to_regex(m.group(2)), re.IGNORECASE))
                )
            else:
                raise ListError(f"deny.txt:{n}: unknown prefix {m.group(1)!r}")
        except re.error as e:
            raise ListError(f"deny.txt:{n}: bad regex: {e}") from e
    for n, line in _lines(imports_allow_text):
        if any(c in line for c in "*?[] \t") or line.startswith(("/", ".")):
            raise ListError(
                f"imports-allow.txt:{n}: entries are exact paths/names, no globs"
            )
        L.import_allow.add(line)
    if not L.allow or not L.deny_paths:
        raise ListError("allow.txt and deny.txt must both be non-empty")
    return L


def load_lists(directory: str) -> Lists:
    texts = []
    for name in ("allow.txt", "deny.txt", "imports-allow.txt"):
        with open(posixpath.join(directory, name), encoding="utf-8") as f:
            texts.append(f.read())
    L = parse_lists(*texts)
    if not L.import_allow:
        raise ListError("imports-allow.txt must be non-empty")
    return L


# -- per-rule helpers ---------------------------------------------------------
def path_problem(p) -> str | None:
    if not isinstance(p, str) or not p:
        return "empty path"
    if len(p) > MAX_PATH_LEN:
        return "path too long"
    if not p.isascii():
        return "non-ASCII path (possible Unicode lookalike)"
    if p.startswith("/") or "\\" in p:
        return "absolute path or backslash"
    for seg in p.split("/"):
        if seg in ("", ".", ".."):
            return f"empty, '.' or '..' segment in {p!r}"
        if not SAFE_SEGMENT.match(seg):
            return f"unsafe character in segment {seg!r}"
    return None


def deny_hits(L: Lists, p: str) -> list:
    folded = unicodedata.normalize("NFKC", p).casefold()
    return [g for g, rx in L.deny_paths if rx.fullmatch(p) or rx.fullmatch(folded)]


def allowed(L: Lists, p: str) -> bool:
    return any(rx.fullmatch(p) for _, rx in L.allow)


def text_problem(raw: bytes) -> tuple[str | None, str | None]:
    if len(raw) > MAX_FILE_BYTES:
        return None, f"file over {MAX_FILE_BYTES} bytes"
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None, "not UTF-8 text (binary?)"
    for ch in text:
        if ch in BIDI:
            return None, f"bidi control U+{ord(ch):04X} (Trojan Source)"
        if unicodedata.category(ch) == "Cc" and ch not in "\t\n\r":
            return None, f"control character U+{ord(ch):04X}"
    return text, None


def strip_comments(text: str, js: bool = True) -> str:
    """Replace comments with a space, leaving string/template contents alone.

    A small lexer, not a parser: a regex literal containing a quote can
    confuse it. That is why callers scan the RAW text as well, and why every
    import pattern tolerates comments itself. A miss needs both to fail.
    `//` is a comment only in JS (in CSS it is a protocol-relative URL)."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
        elif js and c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
        elif c in "'\"`":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def scan_views(name: str, text: str) -> list:
    """Every text an attacker's bytes must survive: raw, comment-stripped,
    and the NFKC form of each."""
    views = [text]
    if name.endswith(CODE_EXTS):
        views.append(strip_comments(text, js=name.endswith(JS_EXTS)))
    views += [unicodedata.normalize("NFKC", v) for v in list(views)]
    return views


def content_hits(L: Lists, name: str, text: str) -> list:
    is_code = name.endswith(CODE_EXTS)
    views = scan_views(name, text)
    return [
        src
        for src, rx, scope in L.deny_content
        if (scope == "all" or is_code) and any(rx.search(v) for v in views)
    ]


# On the RAW text (comments intact) only statement-start imports count, so
# prose in a comment ("... from 'x'") is not read as an import, while a real
# import hidden from the comment stripper by a lexer confusion still is.
RAW_IMPORT_RES = [
    re.compile(
        r"(?:^|[;{}])[ \t]*(?:import|export)\b[^;'\"`]*?\bfrom"
        + GAP
        + r"""(['"`])(.*?)\1""",
        re.MULTILINE,
    ),
    re.compile(r"(?:^|[;{}])[ \t]*import" + GAP + r"""(['"`])(.*?)\1""", re.MULTILINE),
]


def import_specs(name: str, text: str) -> list:
    """Specifiers from the comment-stripped text (all import forms, comments
    between tokens tolerated) plus statement-start imports in the raw text,
    each also NFKC-normalised."""
    specs: list = []
    views = []
    if name.endswith(CODE_EXTS):
        views.append((strip_comments(text, js=name.endswith(JS_EXTS)), IMPORT_RES))
    views.append((text, RAW_IMPORT_RES + IMPORT_RES[2:]))
    views += [(unicodedata.normalize("NFKC", v), r) for v, r in list(views)]
    for v, rxs in views:
        for rx in rxs:
            for m in rx.finditer(v):
                if m.group(2) not in specs:
                    specs.append(m.group(2))
    return specs


def resolve_import(file_path: str, spec: str):
    """Canonicalise a specifier BEFORE matching (review R1 #1).

    -> ('path', repo-relative base) | ('bare', name) | ('bad', why).
    Anything non-canonical is 'bad' (human): no `?`/`#`/`%`/backslash/space/
    `${`, no `//`, no `.`/`..`/empty segment except a leading `./` or run of
    `../`, nothing that leaves apps/web/src (for `@/`) or the repo."""
    if not spec or not spec.isascii() or any(c in spec for c in "?#%\\ \t\n`$"):
        return "bad", f"non-canonical import specifier {spec!r}"
    if "//" in spec or spec.endswith("/"):
        return "bad", f"non-canonical import specifier {spec!r}"
    if spec.startswith("@/"):
        if not file_path.startswith("apps/web/"):
            return "bad", f"'@/' import outside apps/web: {spec}"
        rest = spec[2:].split("/")
        if any(s in ("", ".", "..") for s in rest):
            return "bad", f"dot segment in alias import {spec!r}"
        return "path", "apps/web/src/" + "/".join(rest)
    if spec.startswith(("./", "../")):
        segs = spec.split("/")
        k = 0
        if segs[0] == ".":
            k = 1
        else:
            while k < len(segs) and segs[k] == "..":
                k += 1
        if k == len(segs) or any(s in ("", ".", "..") for s in segs[k:]):
            return "bad", f"dot segment in relative import {spec!r}"
        joined = posixpath.normpath(posixpath.join(posixpath.dirname(file_path), spec))
        if joined.startswith(("..", "/")) or joined == ".":
            return "bad", f"import escapes the repo: {spec}"
        return "path", joined
    if BARE_SPEC.match(spec):
        return "bare", spec
    return "bad", f"unresolvable import specifier {spec!r}"


def import_hits(L: Lists, file_path: str, text: str, tree) -> list:
    """Import rule, ALLOW-list form (review R1 #3).

    A relative/alias import is fine only if the file it resolves to (first
    existing candidate in the head tree) is (a) named in imports-allow.txt, or
    (b) itself an allowed, non-denied path (another UI component / CSS module).
    A bare package is fine only if named in imports-allow.txt. deny.txt
    `import:` globs win over both."""
    reasons = []
    for spec in import_specs(file_path, text):
        kind, val = resolve_import(file_path, spec)
        if kind == "bad":
            reasons.append(val)
            continue
        cands = [val + s for s in RESOLVE_SUFFIXES] if kind == "path" else [val]
        named = [
            g
            for g, rx in L.deny_imports
            if any(rx.fullmatch(c) for c in cands + [spec])
        ]
        if named:
            reasons.append(f"imports {spec!r} (matches import: {named[0]})")
            continue
        if kind == "bare":
            if val not in L.import_allow:
                reasons.append(f"imports package {spec!r}, not in imports-allow.txt")
            continue
        if tree is None:
            reasons.append(f"cannot resolve {spec!r}: head tree not available")
            continue
        target = next((c for c in cands if c in tree), None)
        if target is None:
            reasons.append(f"import {spec!r} resolves to no file in the head tree")
        elif target in L.import_allow or (
            allowed(L, target) and not deny_hits(L, target)
        ):
            continue
        else:
            reasons.append(
                f"imports {target} ({spec!r}): not in imports-allow.txt and not an allowed path"
            )
    return reasons


# -- classifier ---------------------------------------------------------------
def classify(L: Lists, bundle: dict) -> dict:
    pr_reasons: list = []
    files_out: list = []

    if bundle.get("collect_error"):
        pr_reasons.append(f"R0 could not read the PR: {bundle['collect_error']}")
    pr = bundle.get("pr") or {}
    files = bundle.get("files")
    if not isinstance(files, list):
        pr_reasons.append("R0 file list missing")
        files = []
    if not files:
        pr_reasons.append("R0 empty file list")
    if pr.get("changed_files") != len(files):
        pr_reasons.append(
            f"R0 file list is partial: PR says {pr.get('changed_files')}, read {len(files)}"
        )
    if pr.get("base_ref") != REQUIRED_BASE_REF:
        pr_reasons.append(
            f"R0 base branch is {pr.get('base_ref')!r}, not {REQUIRED_BASE_REF} "
            "(lists are only authoritative for that branch)"
        )
    if pr.get("head_repo") != pr.get("base_repo") or not pr.get("base_repo"):
        pr_reasons.append("R0 head repository is not the base repository (fork)")
    if len(files) > MAX_FILES:
        pr_reasons.append(f"R0 {len(files)} files > MAX_FILES {MAX_FILES}")
    total = sum(int(f.get("additions", 0)) + int(f.get("deletions", 0)) for f in files)
    if total > MAX_CHANGED_LINES:
        pr_reasons.append(f"R0 {total} changed lines > {MAX_CHANGED_LINES}")

    tree = bundle.get("tree")
    tree = set(tree) if isinstance(tree, list) else None
    for f in files:
        name = f.get("filename")
        prev = f.get("previous_filename")
        status = f.get("status")
        reasons: list = []
        paths = [name] + ([prev] if prev else [])
        bad_path = False
        for p in paths:
            why = path_problem(p)
            if why:
                reasons.append(f"R1 {why}")
                bad_path = True
        if status not in AUTO_STATUSES:
            reasons.append(f"R2 status {status!r} is never auto")
        if not bad_path:
            for p in paths:
                for g in deny_hits(L, p):
                    reasons.append(f"R3 {p} matches deny {g}")
                if not allowed(L, p):
                    reasons.append(f"R4 {p} is not in allow.txt")
        if status != "removed":
            if f.get("type") != "file":
                reasons.append(
                    f"R5 head object is {f.get('type')!r}, not a regular file"
                )
            if not f.get("patch"):
                reasons.append("R5 no textual patch (binary or diff too large)")
            raw = f.get("content_b64")
            if raw is None:
                reasons.append("R5 head content was not read")
            else:
                try:
                    data = base64.b64decode(raw, validate=True)
                except Exception:  # noqa: BLE001 - any decode failure is human
                    data = None
                    reasons.append("R5 head content is not valid base64")
                if data is not None:
                    text, why = text_problem(data)
                    if why:
                        reasons.append(f"R5 {why}")
                    if text is not None:
                        for src in content_hits(L, str(name), text):
                            reasons.append(f"R6 whole-file content matches `{src}`")
                        if isinstance(name, str) and name.endswith(CODE_EXTS):
                            for r in import_hits(L, name, text, tree):
                                reasons.append(f"R7 {r}")
        files_out.append(
            {"filename": name, "previous_filename": prev, "reasons": reasons}
        )

    human = bool(pr_reasons) or any(x["reasons"] for x in files_out)
    return {
        "verdict": "human" if human else "auto",
        "pr_reasons": pr_reasons,
        "files": files_out,
    }


# -- collect (network; REST via gh) -------------------------------------------
def _gh(args: list) -> str:
    r = subprocess.run(
        ["gh", "api", *args], capture_output=True, text=True, check=False
    )
    if r.returncode != 0:
        raise RuntimeError(f"gh api {args[0]} exited {r.returncode}")
    return r.stdout


COMPARE_FILE_CAP = 300  # GitHub's compare endpoint returns at most 300 files


def collect(repo: str, pr_num: int, head_sha: str) -> dict:
    """Read one PR as DATA, pinned to SHAs (review R1 #6).

    The file list comes from `compare/{base_sha}...{head_sha}`, which is
    immutable for those two SHAs, not from the moving `pulls/N/files`. The PR
    is re-read afterwards; if its head or base moved, this fails closed and
    the newer event's run classifies the new head."""
    bundle: dict = {"pr": {}, "files": []}
    try:
        pr = json.loads(_gh([f"repos/{repo}/pulls/{pr_num}"]))
        if pr["head"]["sha"] != head_sha:
            raise RuntimeError(
                "PR head moved since the event; a newer run will classify it"
            )
        base_sha = pr["base"]["sha"]
        bundle["pr"] = {
            "number": pr_num,
            "head_sha": head_sha,
            "base_sha": base_sha,
            "base_ref": pr["base"].get("ref"),
            "changed_files": pr.get("changed_files"),
            "head_repo": (pr["head"].get("repo") or {}).get("full_name"),
            "base_repo": pr["base"]["repo"]["full_name"],
        }
        cmp_ = json.loads(_gh([f"repos/{repo}/compare/{base_sha}...{head_sha}"]))
        files = cmp_.get("files")
        if not isinstance(files, list):
            raise RuntimeError("compare returned no file list")  # noqa: TRY004
        if len(files) >= COMPARE_FILE_CAP:
            raise RuntimeError("compare file list is at GitHub's 300-file cap")
        bundle["files"] = [
            {
                k: f.get(k)
                for k in (
                    "filename",
                    "previous_filename",
                    "status",
                    "additions",
                    "deletions",
                    "patch",
                )
            }
            for f in files
        ]
        if len(files) > MAX_FILES:
            return bundle  # classifies human on R0; do not fetch hundreds of blobs
        # The git tree gives each path's MODE, which the contents API hides
        # (it follows a symlink to a file and reports type "file"). Its path
        # list is also what imports are resolved against.
        tree = json.loads(_gh([f"repos/{repo}/git/trees/{head_sha}?recursive=1"]))
        if tree.get("truncated"):
            raise RuntimeError("git tree listing truncated")
        by_path = {
            e["path"]: e for e in tree.get("tree", []) if e.get("type") == "blob"
        }
        bundle["tree"] = sorted(by_path)
        for f in bundle["files"]:
            if f["status"] == "removed" or path_problem(f["filename"]):
                continue
            e = by_path.get(f["filename"])
            if e is None:
                f["type"] = "missing"
                continue
            f["type"] = MODE_TYPES.get(e.get("mode"), f"mode {e.get('mode')}")
            if f["type"] == "file":
                blob = json.loads(_gh([f"repos/{repo}/git/blobs/{e['sha']}"]))
                if blob.get("encoding") != "base64":
                    raise RuntimeError(f"unexpected blob encoding for {f['filename']}")
                f["content_b64"] = "".join(blob.get("content", "").split())
        again = json.loads(_gh([f"repos/{repo}/pulls/{pr_num}"]))
        if again["head"]["sha"] != head_sha or again["base"]["sha"] != base_sha:
            raise RuntimeError(
                "PR head or base moved while reading; refusing a mixed read"
            )
    except Exception as e:  # noqa: BLE001 - fail closed, never guess
        bundle["collect_error"] = str(e)[:300]
    return bundle


def summary_markdown(v: dict) -> str:
    def esc(s) -> str:
        return re.sub(r"[`|<>\r\n]", "_", str(s))[:200]

    lines = [f"**Class: `{v['verdict']}`**", ""]
    for r in v["pr_reasons"]:
        lines.append(f"- PR: {esc(r)}")
    lines += ["", "| file | reasons |", "|---|---|"]
    for f in v["files"]:
        rs = "; ".join(esc(r) for r in f["reasons"][:6]) or "ok"
        if len(f["reasons"]) > 6:
            rs += f"; +{len(f['reasons']) - 6} more"
        lines.append(f"| {esc(f['filename'])} | {rs} |")
    return "\n".join(lines)[:60000]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--repo", required=True)
    c.add_argument("--pr", type=int, required=True)
    c.add_argument("--head-sha", required=True)
    c.add_argument("--out", required=True)
    k = sub.add_parser("classify")
    k.add_argument("--lists", required=True)
    k.add_argument("--bundle", required=True)
    k.add_argument("--out")
    k.add_argument("--summary-out")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "collect":
            b = collect(a.repo, a.pr, a.head_sha)
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump(b, f)
            return 0
        L = load_lists(a.lists)
        with open(a.bundle, encoding="utf-8") as f:
            bundle = json.load(f)
        v = classify(L, bundle)
        s = json.dumps(v, indent=2)
        print(s)
        if a.out:
            with open(a.out, "w", encoding="utf-8") as f:
                f.write(s)
        if a.summary_out:
            with open(a.summary_out, "w", encoding="utf-8") as f:
                f.write(summary_markdown(v))
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"autonomy_class: {type(e).__name__}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
