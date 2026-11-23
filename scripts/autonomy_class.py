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

  R0  whole-PR shape   file list unreadable / partial / empty; more than
                       MAX_FILES files; more than MAX_CHANGED_LINES lines
                       changed; head repo is a fork.
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
  R6  content          a deny.txt `content:` / `content-cs:` regex matches
                       the WHOLE head file (raw or NFKC-normalised) — not
                       just the changed lines (C2).
  R7  import           an import / export-from / @import in the file resolves
                       to a deny.txt `import:` glob, or cannot be resolved
                       (C1).

Lists are read from the directory given by --lists; in CI that is the BASE
branch's checkout (.github/workflows/autonomy-class.yml), never the PR's.

USAGE
-----
  autonomy_class.py collect --repo O/R --pr N --head-sha SHA --out bundle.json
      Network step: reads the PR, its file list (+ patches) and every changed
      file's head content through `gh api` (REST only). Never runs PR code.
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
CODE_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css")
RESOLVE_SUFFIXES = (
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".css",
    "/index.ts",
    "/index.tsx",
    "/index.js",
)
# Bidi overrides/isolates (Trojan Source) and other controls.
BIDI = set("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f")

IMPORT_RES = [
    re.compile(r"""\bfrom\s*(['"])(.+?)\1"""),
    re.compile(r"""\bimport\s*(['"])(.+?)\1"""),
    re.compile(r"""@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1"""),
]


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
    deny_content: list = field(default_factory=list)  # (source, compiled)
    deny_imports: list = field(default_factory=list)


PREFIX = re.compile(r"^([a-z][a-z-]*):\s+(.*)$")


def _lines(text: str):
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line and not line.startswith("#"):
            yield n, line


def parse_lists(allow_text: str, deny_text: str) -> Lists:
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
            elif m.group(1) == "content":
                L.deny_content.append((line, re.compile(m.group(2), re.IGNORECASE)))
            elif m.group(1) == "content-cs":
                L.deny_content.append((line, re.compile(m.group(2))))
            elif m.group(1) == "import":
                L.deny_imports.append(
                    (m.group(2), re.compile(glob_to_regex(m.group(2)), re.IGNORECASE))
                )
            else:
                raise ListError(f"deny.txt:{n}: unknown prefix {m.group(1)!r}")
        except re.error as e:
            raise ListError(f"deny.txt:{n}: bad regex: {e}") from e
    if not L.allow or not L.deny_paths:
        raise ListError("allow.txt and deny.txt must both be non-empty")
    return L


def load_lists(directory: str) -> Lists:
    with open(posixpath.join(directory, "allow.txt"), encoding="utf-8") as f:
        a = f.read()
    with open(posixpath.join(directory, "deny.txt"), encoding="utf-8") as f:
        d = f.read()
    return parse_lists(a, d)


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


def content_hits(L: Lists, text: str) -> list:
    norm = unicodedata.normalize("NFKC", text)
    return [src for src, rx in L.deny_content if rx.search(text) or rx.search(norm)]


def import_specs(text: str) -> list:
    specs = []
    for rx in IMPORT_RES:
        specs += [m.group(2) for m in rx.finditer(text)]
    return specs


def resolve_import(file_path: str, spec: str):
    """-> (kind, value): ('path', repo-relative) | ('bare', spec) | ('bad', why)."""
    if spec.startswith("@/"):
        if not file_path.startswith("apps/web/"):
            return "bad", f"'@/' import outside apps/web: {spec}"
        return "path", "apps/web/src/" + spec[2:]
    if spec.startswith(("./", "../")) or spec in (".", ".."):
        joined = posixpath.normpath(posixpath.join(posixpath.dirname(file_path), spec))
        if joined.startswith(("..", "/")):
            return "bad", f"import escapes the repo: {spec}"
        return "path", joined
    if spec.startswith("/") or "\\" in spec or not spec.isascii():
        return "bad", f"unresolvable import specifier: {spec!r}"
    return "bare", spec


def import_hits(L: Lists, file_path: str, text: str) -> list:
    reasons = []
    for spec in import_specs(text):
        kind, val = resolve_import(file_path, spec)
        if kind == "bad":
            reasons.append(val)
            continue
        cands = [val + s for s in RESOLVE_SUFFIXES] if kind == "path" else [val]
        for g, rx in L.deny_imports:
            if any(rx.fullmatch(c) for c in cands):
                reasons.append(f"imports {spec!r} (matches import: {g})")
                break
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
    if pr.get("head_repo") != pr.get("base_repo") or not pr.get("base_repo"):
        pr_reasons.append("R0 head repository is not the base repository (fork)")
    if len(files) > MAX_FILES:
        pr_reasons.append(f"R0 {len(files)} files > MAX_FILES {MAX_FILES}")
    total = sum(int(f.get("additions", 0)) + int(f.get("deletions", 0)) for f in files)
    if total > MAX_CHANGED_LINES:
        pr_reasons.append(f"R0 {total} changed lines > {MAX_CHANGED_LINES}")

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
                        for src in content_hits(L, text):
                            reasons.append(f"R6 whole-file content matches `{src}`")
                        if isinstance(name, str) and name.endswith(CODE_EXTS):
                            for r in import_hits(L, name, text):
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


def collect(repo: str, pr_num: int, head_sha: str) -> dict:
    bundle: dict = {"pr": {}, "files": []}
    try:
        pr = json.loads(_gh([f"repos/{repo}/pulls/{pr_num}"]))
        if pr["head"]["sha"] != head_sha:
            raise RuntimeError(
                "PR head moved since the event; a newer run will classify it"
            )
        bundle["pr"] = {
            "number": pr_num,
            "head_sha": head_sha,
            "changed_files": pr.get("changed_files"),
            "head_repo": (pr["head"].get("repo") or {}).get("full_name"),
            "base_repo": pr["base"]["repo"]["full_name"],
        }
        out = _gh(
            [
                "--paginate",
                f"repos/{repo}/pulls/{pr_num}/files?per_page=100",
                "--jq",
                ".[]",
            ]
        )
        files = [json.loads(line) for line in out.splitlines() if line.strip()]
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
        # (it follows a symlink to a file and reports type "file").
        tree = json.loads(_gh([f"repos/{repo}/git/trees/{head_sha}?recursive=1"]))
        if tree.get("truncated"):
            raise RuntimeError("git tree listing truncated")
        by_path = {e["path"]: e for e in tree.get("tree", [])}
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
