#!/usr/bin/env python3
"""Classify a pull request as `auto` or `human` (AGENTIC-L5-PLAN v1.2.1 \u00a72 R1).

WHAT IT DECIDES
---------------
CONTENT-ONLY, NARROWED (Jon, LEDGER-18 row 143; narrowed 2026-11-23,
LEDGER-19A row 49, after review R3). `auto` means: every changed file is a
MODIFIED, allowed, non-denied regular text file, and a PARSER proves that the
ONLY differences between its base and head versions are
  (a) .tsx: JSX TEXT (JsxText nodes; not attributes, not {"..."} children,
      not any string literal or template) whose direct parent is an intrinsic
      <p>, <h1>-<h6>, <li>, <span>, <strong> or <em> with no spread, on*,
      ref, key or dangerouslySetInnerHTML attribute, inside a tree of
      intrinsic elements (never under <a>, <button>, <label>, <option>,
      <title>, <script>, <style>, <textarea>, ... or a component) returned by
      a React component; the old and new text hold no URL-like token and no
      `<`, `>`, `{`, `}` after entity decoding;
  (b) .module.css: the value of a `color` or `background-color` declaration,
      both old and new values in a strict colour grammar (hex, numeric
      rgb()/rgba()/hsl()/hsla(), a fixed list of named colours, or
      var(--[a-z0-9-]+)), only under plain selectors or @media (never
      :export / :import or another at-rule).
Everything else is `human`: every string literal anywhere, any comment or
token change, whitespace outside the changed text, .md / docs and every other
file type, and file add / delete / rename / mode change. Two review rounds
showed that regex denylists over JS lose, and R3 showed that guessing which
literals are "prose" loses too, so the deciding rule is R8 and it proves
positions instead of guessing; R0-R7 stay as extra fail-closed layers. The
class is an INPUT to the bot merge path (rollback-safe + adversarial-reviewed
+ a non-author VERDICT: PASS), never a merge by itself.

BINDING. The verdict is for one (head SHA, base SHA) pair: `collect` records
both and fails closed if either moves while reading, and the workflow
re-checks both (and that base is still the v3/main tip) right before posting,
else it posts `human`. Consumers must read the LATEST check-run named
`autonomy-class` from the GitHub Actions app (app id 15368) for the exact head
SHA, and require conclusion success, title `auto`, and external_id equal to
the current v3/main tip; anything else is `human`.

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
  R2  status           only `modified` can be `auto`. Added, renamed,
                       removed, copied, `changed` (mode) and unknown: `human`.
  R3  deny path        new OR previous path matches deny.txt (case-
                       insensitive).
  R4  not allowed      new or previous path matches no allow.txt line
                       (case-sensitive).
  R5  file object      head object is not a regular file (symlink,
                       submodule), has no textual patch (binary / too large),
                       is over MAX_FILE_BYTES, is not strict UTF-8, or holds a
                       NUL, a control character or a bidi override.
  R6  content          a deny.txt regex matches the WHOLE head file
                       (defence in depth; secrets, money, network).
  R7  import           every import in the head file resolves to an
                       imports-allow.txt entry or an allowed path (defence in
                       depth; R8 already forbids any import change).
  R8  content-only     base object missing / not a regular file /
                       unreadable; TS/TSX: parse error, or the token streams
                       (comments verbatim) differ, or a changed literal is
                       not JSX text under the rules in (a) above, or the
                       text is/becomes empty, URL-like, markup or braces, or
                       the file reads rendered text back (textContent, ...),
                       or bytes outside the changed text differ; CSS: any
                       backslash, any change to selectors / properties /
                       at-rules / comments / whitespace, or a changed value
                       outside (b); any other file type (.md included).

Lists (allow.txt, deny.txt, imports-allow.txt) are read from the directory
given by --lists; in CI that is a checkout of v3/main
(.github/workflows/autonomy-class.yml), never the PR's.

USAGE
-----
  autonomy_class.py collect --repo O/R --pr N --head-sha SHA --out bundle.json
      Network step: reads the PR, its file list (+ patches) from the
      SHA-pinned compare endpoint, the head and base trees (modes, paths) and
      every changed file's head AND base blob through `gh api` (REST only).
      Never runs PR code.
      Any read error is recorded in the bundle as `collect_error`, which
      classifies as `human` (fail closed).
  autonomy_class.py classify --lists DIR --bundle bundle.json [--out v.json]
                             [--typescript DIR]
      Pure function of (lists, bundle, parser). Prints the verdict JSON.
  autonomy_class.py install-parser --lockfile pnpm-lock.yaml --tarball T --dest D
      Checks a downloaded typescript tarball against the sha512 that the
      lockfile pins for TS_VERSION and unpacks it (no install scripts run).

Stdlib + node (for the TS parser only). Exit codes (house convention, scripts/_gate_exit.py):
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

# Content-only (R8) needs a base AND a head version of the same path, so only
# `modified` can be `auto`. Added, renamed, removed, copied, mode-changed and
# unknown statuses are all `human`.
AUTO_STATUSES = {"modified"}
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


# -- R8 content-only (NARROWED, Jon 2026-11-23, LEDGER-19A row 49) -----------
# A changed file is `auto` only if a PARSER proves that base and head differ
# in exactly these things and nothing else:
#   (a) .tsx: JSX TEXT (JsxText nodes only: not attributes, not {"..."}
#       children, not string literals anywhere) whose direct parent is an
#       intrinsic <p>, <h1>-<h6>, <li>, <span>, <strong> or <em> with no
#       spread / handler / ref / key / dangerouslySetInnerHTML attribute,
#       inside a tree of intrinsic elements returned by a React component
#       (rules in scripts/autonomy_class_ast.cjs). The new and old text must
#       be plain words: no URL-like token, no `<>{}` after entity decoding,
#       only listed named entities, not empty.
#   (b) .css: the VALUE of a `color` or `background-color` declaration,
#       where both old and new values match a strict colour grammar
#       (COLOR_RE), and the declaration is only inside plain selectors or
#       @media (never :export / :import, never another at-rule).
# Everything else is `human`: every string literal (consts, attributes,
# props, templates, String.raw / tagged), any comment, any token, any
# whitespace outside a changed text/value, .md and every other file type.
# The base and head token streams (comments verbatim) must be IDENTICAL, and
# the two files must be byte-identical once the changed JSX text / colour
# values are masked out (CRLF and a leading BOM are normalised).
TS_VERSION = "5.9.3"  # the version pnpm-lock.yaml pins; checked at load time
AST_HELPER = posixpath.join(
    posixpath.dirname(posixpath.abspath(__file__)), "autonomy_class_ast.cjs"
)
TS_EXTS = (".tsx", ".ts")  # .ts has no JSX, so any literal change there is human
URLISH = [
    re.compile(r"://"),
    re.compile(r"(?i)www\."),
    re.compile(r"(?i)(?:javascript|vbscript|data|blob|file|mailto|tel|about)\s*:"),
    re.compile(r"^\s*(?:/|\./|\.\./|~/)"),
    re.compile(r"^\s*[A-Za-z][A-Za-z0-9+.-]*:\S"),  # scheme:...
    re.compile(r"(?i)url\s*\(|@import|/api\b"),
    re.compile(r"(?i)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]|\b)"),
]
# Named entities a text edit may use (decoded before every check). Any other
# named entity is `human`; numeric ones are decoded and checked like text.
JSX_ENTITIES = {
    "amp": "&",
    "nbsp": "\u00a0",
    "quot": '"',
    "apos": "'",
    "mdash": "\u2014",
    "ndash": "\u2013",
    "hellip": "\u2026",
    "lsquo": "\u2018",
    "rsquo": "\u2019",
    "ldquo": "\u201c",
    "rdquo": "\u201d",
    "middot": "\u00b7",
    "times": "\u00d7",
    "bull": "\u2022",
    "copy": "\u00a9",
    "reg": "\u00ae",
    "trade": "\u2122",
    "deg": "\u00b0",
    "larr": "\u2190",
    "rarr": "\u2192",
    "uarr": "\u2191",
    "darr": "\u2193",
    "laquo": "\u00ab",
    "raquo": "\u00bb",
}
ENTITY = re.compile(r"&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));")
CSS_COLOR_PROPS = ("color", "background-color")
CSS_NAMED_COLORS = frozenset(
    """aliceblue antiquewhite aqua aquamarine azure beige bisque black
    blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
    chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
    darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
    darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
    darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
    deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
    fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
    honeydew hotpink indianred indigo ivory khaki lavender lavenderblush
    lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
    lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
    lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
    limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
    mediumpurple mediumseagreen mediumslateblue mediumspringgreen
    mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
    navajowhite navy oldlace olive olivedrab orange orangered orchid
    palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
    peru pink plum powderblue purple rebeccapurple red rosybrown royalblue
    saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
    slateblue slategray slategrey snow springgreen steelblue tan teal thistle
    tomato turquoise violet wheat white whitesmoke yellow yellowgreen
    transparent currentcolor""".split()  # noqa: SIM905 - 150 names, one per word
)
_NUM = r"-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)"
_ARG = _NUM + r"(?:%|deg)?"
COLOR_RE = re.compile(
    r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})"
    r"|(?:rgb|rgba|hsl|hsla)\( *" + _ARG + r"(?: *[, ] *" + _ARG + r"){2}"
    r"(?: *[,/] *" + _NUM + r"%?)? *\)"
    r"|var\(--[a-z0-9-]+\)"
)


class ContentError(Exception):
    pass


def _decode(f: dict, key: str):
    raw = f.get(key)
    if raw is None:
        return None, "not read"
    try:
        data = base64.b64decode(raw, validate=True)
    except Exception:  # noqa: BLE001 - any decode failure is human
        return None, "not valid base64"
    text, why = text_problem(data)
    return text, why


def base_problems(f: dict) -> list:
    """R8 needs the base version of the same path, as a regular text file."""
    if f.get("status") != "modified":
        return []  # already human on R2
    out = []
    if f.get("base_type") != "file":
        out.append(f"R8 base object is {f.get('base_type')!r}, not a regular file")
    _, why = _decode(f, "base_content_b64")
    if why:
        out.append(f"R8 base content {why}")
    return out


def decode_jsx_text(raw: str) -> tuple[str | None, str | None]:
    """JSX text as React renders it (entities decoded) or (None, why)."""
    bad = None

    def rep(m):
        nonlocal bad
        dec, hexa, name = m.groups()
        if name is None:
            try:
                ch = chr(int(dec) if dec is not None else int(hexa, 16))
            except (ValueError, OverflowError):
                bad = f"bad numeric entity {m.group(0)}"
                return ""
            cat = unicodedata.category(ch)
            if ch in BIDI or cat in ("Cc", "Cs", "Co", "Cn"):
                bad = f"entity {m.group(0)} decodes to a control character"
            return ch
        if name not in JSX_ENTITIES:
            bad = f"named entity {m.group(0)} is not on the text list"
            return ""
        return JSX_ENTITIES[name]

    text = ENTITY.sub(rep, raw)
    return (None, bad) if bad else (text, None)


def jsx_text_problem(raw: str) -> str | None:
    """Is this (old or new) JSX text plain words? None = yes."""
    text, why = decode_jsx_text(raw)
    if why:
        return why
    if not text.strip():
        return "changed JSX text is or becomes empty"
    if any(c in text for c in "<>{}\\"):
        return f"changed JSX text holds markup or braces: {text.strip()[:60]!r}"
    for rx in URLISH:
        if rx.search(text):
            return f"changed JSX text is or holds a URL/path: {text.strip()[:60]!r}"
    return None


def _norm(text: str) -> str:
    return text.lstrip("﻿").replace("\r\n", "\n")


def masked_equal(base: str, head: str, bspans: list, hspans: list) -> bool:
    """True if the files are identical once the given spans are masked."""

    def mask(text, spans):
        out, last = [], 0
        for s, e in sorted(spans):
            out.append(text[last:s])
            out.append("\x00")
            last = e
        out.append(text[last:])
        return _norm("".join(out))

    return mask(base, bspans) == mask(head, hspans)


def css_parse(text: str):
    """Strict CSS tokenizer -> (shape, decls). Raises ContentError.

    shape keeps comments (verbatim), selectors/at-rule preludes, statements,
    property names and braces. decls: one (prop, value, context, (start, end),
    raw_declaration) per declaration, where context is the tuple of enclosing
    preludes and (start, end) the value's span. No backslash anywhere."""
    if "\\" in text:
        raise ContentError("backslash escape in CSS")
    shape: list = []
    decls: list = []
    stack: list = []
    buf: list = []
    seg_start = None
    paren = 0
    i, n = 0, len(text)

    def flush(end: str, at: int):
        nonlocal seg_start
        seg = " ".join("".join(buf).split())
        raw = text[seg_start:at] if seg_start is not None else ""
        start = seg_start
        buf.clear()
        seg_start = None
        if end == "{":
            shape.append(("P", seg))
            stack.append(seg)
            return
        if not seg:
            return
        colon = _top_level_colon(seg)
        if stack and not seg.startswith("@") and colon > 0:
            shape.append(("D", seg[:colon].strip()))
            rc = _top_level_colon(raw)
            vs = start + rc + 1
            while vs < at and text[vs].isspace():
                vs += 1
            ve = at
            while ve > vs and text[ve - 1].isspace():
                ve -= 1
            decls.append(
                (seg[:colon].strip(), text[vs:ve], tuple(stack), (vs, ve), raw)
            )
        else:
            shape.append(("S", seg))

    while i < n:
        c = text[i]
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                raise ContentError("unterminated CSS comment")
            shape.append(("C", text[i : j + 2]))
            buf.append(" ")
            i = j + 2
            continue
        if seg_start is None and not c.isspace() and c not in "{};":
            seg_start = i
        if c in "'\"":
            j = text.find(c, i + 1)
            nl = text.find("\n", i + 1)
            if j < 0 or (0 <= nl < j):
                raise ContentError("unterminated CSS string")
            buf.append(text[i : j + 1])
            i = j + 1
        elif c == "(":
            paren += 1
            buf.append(c)
            i += 1
        elif c == ")":
            paren -= 1
            if paren < 0:
                raise ContentError("unbalanced ) in CSS")
            buf.append(c)
            i += 1
        elif paren == 0 and c == "{":
            flush("{", i)
            shape.append(("{",))
            i += 1
        elif paren == 0 and c == "}":
            flush("}", i)
            if not stack:
                raise ContentError("unbalanced } in CSS")
            stack.pop()
            shape.append(("}",))
            i += 1
        elif paren == 0 and c == ";":
            flush(";", i)
            shape.append((";",))
            i += 1
        else:
            buf.append(c)
            i += 1
    flush(";", n)
    if stack or paren:
        raise ContentError("unbalanced braces or parentheses in CSS")
    return shape, decls


def _top_level_colon(seg: str) -> int:
    q = None
    par = 0
    for k, ch in enumerate(seg):
        if q:
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch
        elif ch == "(":
            par += 1
        elif ch == ")":
            par -= 1
        elif ch == ":" and par == 0:
            return k
    return -1


def css_color_ok(value: str) -> bool:
    return bool(COLOR_RE.fullmatch(value)) or value in CSS_NAMED_COLORS


def css_context_problem(ctx: tuple) -> str | None:
    for prelude in ctx:
        low = prelude.lower()
        if low.startswith("@"):
            if not re.match(r"@media\b", low):
                return f"declaration inside at-rule {prelude[:40]!r}"
        elif ":export" in low or ":import" in low:
            return f"declaration inside ICSS block {prelude[:40]!r}"
    return None


def css_problems(base: str, head: str) -> list:
    try:
        bs, bd = css_parse(base)
        hs, hd = css_parse(head)
    except ContentError as e:
        return [str(e)]
    if bs != hs or len(bd) != len(hd):
        return ["CSS structure changed (selector, property, at-rule or comment)"]
    out = []
    bspans, hspans = [], []
    for (prop, old, ctx, bsp, braw), (_, new, _, hsp, hraw) in zip(bd, hd):
        if old == new:
            continue
        bspans.append(bsp)
        hspans.append(hsp)
        if prop not in CSS_COLOR_PROPS:
            out.append(
                f"changed CSS value of {prop[:40]!r} (only color / background-color)"
            )
            continue
        if "/*" in braw or "/*" in hraw:
            out.append("comment inside a changed CSS declaration")
            continue
        why = css_context_problem(ctx)
        if why:
            out.append(why)
            continue
        for v in (old, new):
            if not css_color_ok(v):
                out.append(f"CSS {prop} value is not a plain colour: {v[:60]!r}")
                break
    if not out and not masked_equal(base, head, bspans, hspans):
        out.append("CSS whitespace or other bytes changed outside a colour value")
    return out


def find_typescript(ts_dir: str | None = None) -> str | None:
    """Path to typescript/lib/typescript.js at exactly TS_VERSION, or None.

    Order: explicit ts_dir, $AUTONOMY_TS_DIR, then the repo's node_modules
    (after `pnpm install --frozen-lockfile`)."""
    import os

    root = posixpath.dirname(posixpath.dirname(posixpath.abspath(__file__)))
    cands = [ts_dir, os.environ.get("AUTONOMY_TS_DIR")] + [
        posixpath.join(root, d, "node_modules", "typescript")
        for d in ("", "apps/web", "packages/types")
    ]
    for d in cands:
        if not d:
            continue
        try:
            with open(posixpath.join(d, "package.json"), encoding="utf-8") as f:
                if json.load(f).get("version") != TS_VERSION:
                    continue
        except (OSError, ValueError):
            continue
        js = posixpath.join(d, "lib", "typescript.js")
        if posixpath.isfile(js):
            return js
    return None


def run_ast_helper(ts_js: str, jobs: list) -> dict:
    payload = json.dumps({"typescript": ts_js, "files": jobs})
    r = subprocess.run(
        ["node", AST_HELPER],
        input=payload,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if r.returncode != 0:
        raise ContentError(f"parser exited {r.returncode}")
    return json.loads(r.stdout)


def ts_problems(base: dict, head: dict, base_text: str, head_text: str) -> list:
    for side, r in (("base", base), ("head", head)):
        if r is None or r.get("error"):
            return [f"{side}: {(r or {}).get('error') or 'no parser result'}"]
    if base["shape"] != head["shape"] or len(base["lits"]) != len(head["lits"]):
        return [
            (
                "code structure changed (identifier, import, attribute, call,"
                " member, key, operator, number or comment differs)"
            )
        ]
    out = []
    bspans, hspans = [], []
    for b, h in zip(base["lits"], head["lits"]):
        if b["raw"] == h["raw"]:  # SOURCE text, never the cooked value
            continue
        bspans.append((b["pos"], b["end"]))
        hspans.append((h["pos"], h["end"]))
        for ctx in (b["ctx"], h["ctx"]):
            if ctx != "text":
                out.append(f"changed literal is not plain JSX text ({ctx[3:]})")
                break
        else:
            why = jsx_text_problem(b["raw"]) or jsx_text_problem(h["raw"])
            if why:
                out.append(why)
    if bspans:
        dom = sorted(set(base.get("domRead") or []) | set(head.get("domRead") or []))
        if dom:
            out.append(
                "file reads rendered text back (" + ", ".join(dom)[:80] + "); "
                "a text change there can change behaviour"
            )
    if not out and not masked_equal(base_text, head_text, bspans, hspans):
        out.append("whitespace or other bytes changed outside JSX text")
    return out


def content_only_problems(files: list, reasons_by_index: dict, ts_dir=None) -> dict:
    """{file index: [why, ...]} for every file R8 cannot prove content-only.

    Runs on every `modified` file, even one already human on R0-R7, so each
    verdict reports R8 independently. A file whose base or head bytes are
    unreadable is already human (R5 / R8 base) and is not parsed. Every file
    must pass here to be `auto`. Only .tsx/.ts and .css have a parser; .md
    (and everything else) is always `human`."""
    out: dict = {}
    jobs: list = []
    pending: dict = {}
    for i, f in enumerate(files):
        if f.get("status") != "modified":
            if not reasons_by_index.get(i):
                out[i] = ["not a modified file"]  # unreachable: R2 fires first
            continue
        name = f.get("filename") if isinstance(f.get("filename"), str) else ""
        base, why_b = _decode(f, "base_content_b64")
        head, why_h = _decode(f, "content_b64")
        if why_b or why_h or base is None or head is None:
            if not reasons_by_index.get(i):
                out[i] = ["base or head content unreadable"]
            continue
        if name.endswith(".css"):
            why = css_problems(base, head)
            if why:
                out[i] = why
            continue
        if name.endswith(TS_EXTS):
            jobs += [
                {"id": f"{i}b", "name": name, "text": base},
                {"id": f"{i}h", "name": name, "text": head},
            ]
            pending[i] = (base, head)
            continue
        out[i] = ["no content-only parser for this file type (only .tsx/.ts/.css)"]
    if pending:
        ts_js = find_typescript(ts_dir)
        if ts_js is None:
            for i in pending:
                out[i] = [f"TypeScript {TS_VERSION} parser not available"]
            return out
        try:
            res = run_ast_helper(ts_js, jobs)
        except Exception as e:  # noqa: BLE001 - parser trouble is human
            for i in pending:
                out[i] = [f"parser failed: {type(e).__name__}"]
            return out
        for i, (btext, htext) in pending.items():
            why = ts_problems(res.get(f"{i}b"), res.get(f"{i}h"), btext, htext)
            if why:
                out[i] = why
    return out


def lockfile_integrity(lock_text: str, version: str = TS_VERSION) -> str:
    """The sha512 integrity pnpm-lock.yaml pins for typescript@version."""
    m = re.search(
        r"^  typescript@" + re.escape(version) + r":\n\s+resolution: \{integrity: "
        r"(sha512-[A-Za-z0-9+/=]+)\}",
        lock_text,
        re.MULTILINE,
    )
    if not m:
        raise ContentError(f"typescript@{version} not pinned in pnpm-lock.yaml")
    return m.group(1)


def install_parser(lockfile: str, tarball: str, dest: str) -> str:
    """Verify a downloaded typescript tarball against the lockfile's sha512
    and unpack it. Returns the package dir (dest/package)."""
    import hashlib
    import tarfile

    with open(lockfile, encoding="utf-8") as f:
        want = lockfile_integrity(f.read())
    with open(tarball, "rb") as f:
        got = "sha512-" + base64.b64encode(hashlib.sha512(f.read()).digest()).decode()
    if got != want:
        raise ContentError("typescript tarball does not match pnpm-lock.yaml")
    with tarfile.open(tarball, "r:gz") as t:
        t.extractall(dest, filter="data")
    return posixpath.join(dest, "package")


# -- classifier ---------------------------------------------------------------
def classify(L: Lists, bundle: dict, ts_dir: str | None = None) -> dict:
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
            reasons += base_problems(f)
        files_out.append(
            {"filename": name, "previous_filename": prev, "reasons": reasons}
        )

    # R8 content-only: one parser pass over every file that is still clean.
    reasons_by_index = {i: x["reasons"] for i, x in enumerate(files_out)}
    for i, why in content_only_problems(files, reasons_by_index, ts_dir).items():
        reasons_by_index[i].extend(f"R8 {w}" for w in why)

    human = bool(pr_reasons) or any(x["reasons"] for x in files_out)
    return {
        "verdict": "human" if human else "auto",
        # The (head, base) pair this verdict is for. The workflow re-checks
        # both right before posting and puts base_sha in the check-run's
        # external_id; consumers compare it with the current v3/main tip.
        "head_sha": pr.get("head_sha"),
        "base_sha": pr.get("base_sha"),
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
        # R8 compares each modified file with the SAME path at base_sha (the
        # v3/main tip this PR would merge into), read the same way.
        btree = json.loads(_gh([f"repos/{repo}/git/trees/{base_sha}?recursive=1"]))
        if btree.get("truncated"):
            raise RuntimeError("base git tree listing truncated")
        base_by_path = {
            e["path"]: e for e in btree.get("tree", []) if e.get("type") == "blob"
        }

        def blob_b64(e: dict, what: str) -> str:
            blob = json.loads(_gh([f"repos/{repo}/git/blobs/{e['sha']}"]))
            if blob.get("encoding") != "base64":
                raise RuntimeError(f"unexpected blob encoding for {what}")
            return "".join(blob.get("content", "").split())

        for f in bundle["files"]:
            if f["status"] == "removed" or path_problem(f["filename"]):
                continue
            e = by_path.get(f["filename"])
            if e is None:
                f["type"] = "missing"
            else:
                f["type"] = MODE_TYPES.get(e.get("mode"), f"mode {e.get('mode')}")
                if f["type"] == "file":
                    f["content_b64"] = blob_b64(e, f["filename"])
            if f["status"] != "modified":
                continue  # human on R2; no base read needed
            be = base_by_path.get(f["filename"])
            if be is None:
                f["base_type"] = "missing"
                continue
            f["base_type"] = MODE_TYPES.get(be.get("mode"), f"mode {be.get('mode')}")
            if f["base_type"] == "file":
                f["base_content_b64"] = blob_b64(be, "base " + f["filename"])
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

    lines = [
        f"**Class: `{v['verdict']}`**",
        "",
        (
            f"Bound to head `{esc(v.get('head_sha'))}` and base"
            f" `{esc(v.get('base_sha'))}` (v3/main tip when classified)."
        ),
        "",
    ]
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
    k.add_argument(
        "--typescript",
        help=f"dir of the typescript@{TS_VERSION} package (else $AUTONOMY_TS_DIR)",
    )
    ip = sub.add_parser("install-parser")
    ip.add_argument("--lockfile", required=True)
    ip.add_argument("--tarball", required=True)
    ip.add_argument("--dest", required=True)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "install-parser":
            print(install_parser(a.lockfile, a.tarball, a.dest))
            return 0
        if a.cmd == "collect":
            b = collect(a.repo, a.pr, a.head_sha)
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump(b, f)
            return 0
        L = load_lists(a.lists)
        with open(a.bundle, encoding="utf-8") as f:
            bundle = json.load(f)
        v = classify(L, bundle, a.typescript)
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
