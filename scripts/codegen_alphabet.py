#!/usr/bin/env python3
"""Codegen: emit the browser-side chord alphabet from the canonical Python one.

Python (``apps/training/model/alphabet.py``) is the single source of truth for
the ChordNet Y1 alphabet (decision record v1.5 — factored 25 quality x 13
bass). The browser runtime needs the same labels and the same ``ALPHABET_SHA``
for ONNX output decoding; drift between the two is a silent correctness bug
(QA-B review H1 — ``claude/phase-2-y1-qa-b-code-review.md``).

Outputs
-------
This generator emits **two** files from the Python module:

1. ``apps/web/src/chord/alphabet.ts`` — the TypeScript mirror. Bundles into the
   browser build as the inference-time label table.
2. ``apps/web/public/alphabet.v1.5.json`` — a JSON fixture. Fetched at model
   load time so the browser can cross-check the deployed alphabet against the
   bundled ``ALPHABET_SHA`` constant and fail loud on a partial / cached
   deploy.

CLI
---
``python scripts/codegen_alphabet.py``
    Regenerate both files in place. Overwrites.

``python scripts/codegen_alphabet.py --check-only``
    Compare the on-disk files to what would be generated right now. Exit 0 on
    match, 2 on drift. Used in CI.

``python scripts/codegen_alphabet.py --from PATH``
    Use ``PATH`` as the canonical ``alphabet.py`` instead of the repo default
    (``apps/training/model/alphabet.py``). Used when PR-Y1.4b is still a
    sibling branch rather than merged to trunk.

SHA cross-validation
--------------------
The generator computes ``ALPHABET_SHA`` from the labels it read out of the
Python module, using the same JSON payload formula as the Python module's own
``_compute_alphabet_sha``. It then asserts:

  * ``computed_sha == module.ALPHABET_SHA`` — Python module is self-consistent.
  * ``parsed_sha(rendered_ts) == computed_sha`` — TS file we are about to write
    carries the right SHA literal.
  * ``parsed_sha(rendered_json) == computed_sha`` — JSON fixture does too.

Any mismatch aborts the run. In ``--check-only`` mode, the checker *also*
parses the on-disk TS file, extracts its ``ALPHABET_SHA`` literal, and
verifies it matches the recomputed SHA — this catches a hand-edited SHA
constant even if the labels look right.

Dependencies
------------
Python 3.11+ stdlib only. No third-party imports (numpy, torch, …). CI must
be able to run this with a vanilla ``actions/setup-python``.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "apps" / "training" / "model" / "alphabet.py"
DEFAULT_TS_OUT = REPO_ROOT / "apps" / "web" / "src" / "chord" / "alphabet.ts"
DEFAULT_JSON_OUT = REPO_ROOT / "apps" / "web" / "public" / "alphabet.v1.5.json"

ALPHABET_VERSION = "y1-v1.5-factored"


@dataclass(frozen=True)
class AlphabetData:
    """Frozen snapshot of the canonical alphabet, read out of alphabet.py."""

    roots: tuple[str, ...]
    quality_labels: tuple[str, ...]
    bass_labels: tuple[str, ...]
    legacy_qualities: tuple[str, ...]
    legacy_labels: tuple[str, ...]
    quality_n_index: int
    bass_same_index: int
    bass_n_index: int
    legacy_n_index: int
    legacy_x_index: int
    module_alphabet_sha: str


def load_alphabet_module(source_path: Path) -> ModuleType:
    """Import ``alphabet.py`` at ``source_path`` as a module (no package).

    The module imports only ``hashlib`` and ``json`` from stdlib, so this works
    in a bare CI environment with nothing but ``setup-python``.
    """
    if not source_path.is_file():
        raise SystemExit(
            f"codegen_alphabet: canonical source not found at {source_path}. "
            "Pass --from <path> to override."
        )
    spec = importlib.util.spec_from_file_location("stemloops_alphabet_canonical", source_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"codegen_alphabet: cannot load {source_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_alphabet(source_path: Path) -> AlphabetData:
    """Pull the frozen label lists off the Python module."""
    mod = load_alphabet_module(source_path)
    required = (
        "ROOTS",
        "QUALITY_LABELS",
        "BASS_LABELS",
        "QUALITIES",
        "LABELS",
        "QUALITY_N_INDEX",
        "BASS_SAME_INDEX",
        "BASS_N_INDEX",
        "N_INDEX",
        "X_INDEX",
        "ALPHABET_SHA",
    )
    missing = [name for name in required if not hasattr(mod, name)]
    if missing:
        raise SystemExit(
            f"codegen_alphabet: {source_path} is missing required symbols: " + ", ".join(missing)
        )
    return AlphabetData(
        roots=tuple(mod.ROOTS),
        quality_labels=tuple(mod.QUALITY_LABELS),
        bass_labels=tuple(mod.BASS_LABELS),
        legacy_qualities=tuple(mod.QUALITIES),
        legacy_labels=tuple(mod.LABELS),
        quality_n_index=int(mod.QUALITY_N_INDEX),
        bass_same_index=int(mod.BASS_SAME_INDEX),
        bass_n_index=int(mod.BASS_N_INDEX),
        legacy_n_index=int(mod.N_INDEX),
        legacy_x_index=int(mod.X_INDEX),
        module_alphabet_sha=str(mod.ALPHABET_SHA),
    )


def compute_sha(data: AlphabetData) -> str:
    """Recompute ``ALPHABET_SHA`` from the parsed label lists.

    Must stay in lockstep with ``_compute_alphabet_sha`` in
    ``apps/training/model/alphabet.py`` — any change to the payload shape
    there must be mirrored here or CI drift-checks will false-fail.
    """
    payload = json.dumps(
        {
            "version": ALPHABET_VERSION,
            "roots": list(data.roots),
            "quality_labels": list(data.quality_labels),
            "bass_labels": list(data.bass_labels),
            "quality_n_index": data.quality_n_index,
            "bass_same_index": data.bass_same_index,
            "bass_n_index": data.bass_n_index,
            "legacy_qualities": list(data.legacy_qualities),
            "legacy_labels": list(data.legacy_labels),
            "legacy_n_index": data.legacy_n_index,
            "legacy_x_index": data.legacy_x_index,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# TypeScript emitter
# ---------------------------------------------------------------------------


def _ts_string_array(items: tuple[str, ...], indent: str = "  ") -> str:
    """Render a tuple as a TS ``[ "a", "b", ... ]`` literal, one item per line."""
    body = ",\n".join(f'{indent}"{item}"' for item in items)
    return "[\n" + body + ",\n]"


def render_typescript(data: AlphabetData, sha: str) -> str:
    """Render the TypeScript mirror. Deterministic — same input, same bytes."""
    roots_ts = _ts_string_array(data.roots)
    quality_ts = _ts_string_array(data.quality_labels)
    bass_ts = _ts_string_array(data.bass_labels)
    legacy_q_ts = _ts_string_array(data.legacy_qualities)
    legacy_labels_ts = _ts_string_array(data.legacy_labels)

    # SHORTHAND_EXACT mirrors Python _FACTORED_SHORTHAND_EXACT: all 24 non-N
    # quality labels. ``N`` is the no-chord slot, never a Harte shorthand.
    shorthand_items = [q for q in data.quality_labels if q != "N"]
    quality_set = ", ".join(f'"{q}"' for q in shorthand_items)
    legacy_q_set = ", ".join(f'"{q}"' for q in data.legacy_qualities)  # noqa: F841
    return f"""// AUTOGENERATED FROM apps/training/model/alphabet.py — DO NOT EDIT BY HAND.
// Regenerate: python scripts/codegen_alphabet.py
// Alphabet version: {ALPHABET_VERSION}
// Alphabet SHA: {sha}
//
// Python is the single source of truth (decision record v1.5 — factored
// 25 quality x 13 bass). This file mirrors it for ORT Web / ONNX inference
// in the browser. The CI job ``alphabet-mirror-sync`` enforces the mirror
// stays in sync; the runtime ``assertAlphabetSha`` guard refuses to decode
// if the deployed JSON fixture disagrees with the bundled ALPHABET_SHA.

export const ALPHABET_SHA = "{sha}";
export const ALPHABET_VERSION = "{ALPHABET_VERSION}";

/** Chromatic roots. Index = pitch class (C=0, B=11). */
export const ROOTS: readonly string[] = Object.freeze({roots_ts} as const);

/** Factored quality head labels (25 classes). Index 24 is ``N`` (no-chord). */
export const QUALITY_LABELS: readonly string[] = Object.freeze({quality_ts} as const);

/**
 * Bass head labels (13 classes).
 * - ``"same"`` (index 0): bass = chord root, or unspecified.
 * - ``"1"`` .. ``"11"`` (indices 1..11): semitones above root.
 * - ``"N"`` (index 12): no bass (no-chord frames).
 */
export const BASS_LABELS: readonly string[] = Object.freeze({bass_ts} as const);

export const N_ROOT = {len(data.roots)};
export const N_QUALITY = {len(data.quality_labels)};
export const N_BASS = {len(data.bass_labels)};
export const QUALITY_N_INDEX = {data.quality_n_index};
export const BASS_SAME_INDEX = {data.bass_same_index};
export const BASS_N_INDEX = {data.bass_n_index};

/**
 * Legacy flat-60 collapsed qualities (Python ``QUALITIES``). Kept for the
 * ``output_mode="flat170"`` compat path (``smoother.ts`` / ``viterbi.ts``).
 * New code uses ``QUALITY_LABELS``.
 */
export const QUALITIES: readonly string[] = Object.freeze({legacy_q_ts} as const);

/** Legacy 62-label flat list: 60 chord labels + ``N`` + ``X``. */
export const labels: readonly string[] = Object.freeze({legacy_labels_ts} as const);

export const NUM_CHORD_LABELS = 60;
export const NUM_LABELS = 60;
export const LEGACY_N_INDEX = {data.legacy_n_index};
export const LEGACY_X_INDEX = {data.legacy_x_index};

// ---------------------------------------------------------------------------
// Harte parsing — ports apps/training/model/alphabet.py ``encode_factored`` /
// ``decode_factored`` verbatim. Round-trip is identity on every canonical
// decode output.
// ---------------------------------------------------------------------------

const N_LABEL = "N";
const X_LABEL = "X";

const QUALITY_INDEX: ReadonlyMap<string, number> = new Map(
  QUALITY_LABELS.map((q, i) => [q, i] as const),
);

const NAT_PC: Readonly<Record<string, number>> = Object.freeze({{
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}});

const DEG_SEMITONES: Readonly<Record<string, number>> = Object.freeze({{
  "1": 0,
  "2": 2,
  "3": 4,
  "4": 5,
  "5": 7,
  "6": 9,
  "7": 11,
  "8": 12,
  "9": 14,
  "10": 16,
  "11": 17,
  "12": 19,
  "13": 21,
}});

const SEMITONES_TO_HARTE: readonly string[] = Object.freeze([
  "1",
  "b2",
  "2",
  "b3",
  "3",
  "4",
  "b5",
  "5",
  "b6",
  "6",
  "b7",
  "7",
]);

const SHORTHAND_EXACT: ReadonlySet<string> = new Set([{quality_set}]);

// Lossy fallbacks for shorthands without their own slot (ports Python
// _FACTORED_LOSSY_FALLBACK). ``aug7`` already has a slot, left in for parity.
const SHORTHAND_FALLBACK: Readonly<Record<string, string>> = Object.freeze({{
  maj11: "maj9",
  maj13: "maj9",
  min11: "min9",
  min13: "min9",
  aug7: "aug7",
}});

function parseRootPc(root: string): number | null {{
  if (!root) return null;
  const letter = root[0].toUpperCase();
  if (!(letter in NAT_PC)) return null;
  let pc = NAT_PC[letter];
  for (let i = 1; i < root.length; i++) {{
    const ch = root[i];
    if (ch === "b") pc -= 1;
    else if (ch === "#") pc += 1;
    else return null;
  }}
  return ((pc % 12) + 12) % 12;
}}

function parseInterval(tok: string): number | null {{
  if (!tok) return null;
  let shift = 0;
  let i = 0;
  while (i < tok.length && (tok[i] === "b" || tok[i] === "#")) {{
    shift += tok[i] === "b" ? -1 : 1;
    i += 1;
  }}
  const deg = tok.slice(i);
  if (!(deg in DEG_SEMITONES)) return null;
  return ((DEG_SEMITONES[deg] + shift) % 12 + 12) % 12;
}}

function stripParens(harte: string): {{ body: string; extras: readonly string[] }} {{
  const open = harte.indexOf("(");
  if (open < 0) return {{ body: harte, extras: [] }};
  const close = harte.indexOf(")", open + 1);
  if (close < 0) return {{ body: harte, extras: [] }};
  const before = harte.slice(0, open);
  const inside = harte.slice(open + 1, close);
  const extras = inside
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return {{ body: before, extras }};
}}

function isAdd9Only(extras: readonly string[]): boolean {{
  return extras.length === 1 && (extras[0] === "9" || extras[0] === "add9");
}}

function isAdd11Only(extras: readonly string[]): boolean {{
  return extras.length === 1 && (extras[0] === "11" || extras[0] === "add11");
}}

export interface FactoredChord {{
  root: number;
  quality: number;
  bass: number;
}}

/**
 * Encode a Harte-syntax chord label to its ``{{root, quality, bass}}`` indices.
 *
 * Returns ``null`` when the label falls outside the 25-quality vocabulary
 * and cannot be mapped. Callers should drop or mark as ``X``.
 *
 * Special cases:
 *   - ``"N"`` → ``{{ root: 0, quality: QUALITY_N_INDEX, bass: BASS_N_INDEX }}``
 *   - ``"X"`` → ``null``
 */
export function encodeFactored(harte: string): FactoredChord | null {{
  if (typeof harte !== "string" || harte.length === 0) return null;
  if (harte === N_LABEL) {{
    return {{ root: 0, quality: QUALITY_N_INDEX, bass: BASS_N_INDEX }};
  }}
  if (harte === X_LABEL) return null;

  let bassTok: string | null = null;
  let body = harte;
  const slash = body.indexOf("/");
  if (slash >= 0) {{
    bassTok = body.slice(slash + 1);
    body = body.slice(0, slash);
  }}

  const stripped = stripParens(body);
  body = stripped.body;
  const extras = stripped.extras;

  let rootStr: string;
  let shorthand: string;
  const colon = body.indexOf(":");
  if (colon >= 0) {{
    rootStr = body.slice(0, colon);
    shorthand = body.slice(colon + 1);
  }} else {{
    rootStr = body;
    shorthand = "";
  }}

  const rootPc = parseRootPc(rootStr);
  if (rootPc === null) return null;
  const root = rootPc;

  let bass: number;
  if (bassTok === null) {{
    bass = BASS_SAME_INDEX;
  }} else {{
    const semis = parseInterval(bassTok);
    bass = semis === null || semis === 0 ? BASS_SAME_INDEX : semis;
  }}

  let quality: string | null = null;
  if (shorthand === "" && extras.length === 0) {{
    quality = "maj";
  }} else if (SHORTHAND_EXACT.has(shorthand) && extras.length === 0) {{
    quality = shorthand;
  }} else if (shorthand === "maj" && isAdd9Only(extras)) {{
    quality = "add9";
  }} else if (shorthand === "maj" && isAdd11Only(extras)) {{
    quality = "add11";
  }} else if (
    shorthand === "maj" &&
    extras.length === 1 &&
    extras[0] === "13"
  ) {{
    quality = "13";
  }} else if (shorthand === "maj6" && isAdd9Only(extras)) {{
    quality = "add6";
  }} else if (
    shorthand === "aug" &&
    extras.length === 1 &&
    extras[0] === "b7"
  ) {{
    quality = "aug7";
  }} else if (shorthand === "7") {{
    // 7(b9), 7(#9), 7(#11), 7(b13), …: collapse onto plain 7.
    quality = "7";
  }} else if (SHORTHAND_EXACT.has(shorthand)) {{
    // Known shorthand + unknown extras → drop extras (lossy but safe).
    quality = shorthand;
  }} else if (shorthand in SHORTHAND_FALLBACK) {{
    quality = SHORTHAND_FALLBACK[shorthand];
  }} else if (shorthand === "1") {{
    quality = "5";
  }} else {{
    return null;
  }}

  const qualityIdx = QUALITY_INDEX.get(quality);
  if (qualityIdx === undefined) return null;
  return {{ root, quality: qualityIdx, bass }};
}}

/**
 * Decode ``{{root, quality, bass}}`` indices back to a canonical Harte string.
 *
 * - ``quality === QUALITY_N_INDEX`` → ``"N"``.
 * - ``bass === BASS_SAME_INDEX`` or ``bass === BASS_N_INDEX`` → no slash suffix.
 * - ``bass`` in ``[1, 11]`` → ``"/<harte-interval>"`` suffix.
 */
export function decodeFactored(
  root: number,
  quality: number,
  bass: number,
): string {{
  if (!Number.isInteger(root) || root < 0 || root >= N_ROOT) {{
    throw new RangeError(`decodeFactored: root ${{root}} out of range [0, ${{N_ROOT}})`);
  }}
  if (!Number.isInteger(quality) || quality < 0 || quality >= N_QUALITY) {{
    throw new RangeError(
      `decodeFactored: quality ${{quality}} out of range [0, ${{N_QUALITY}})`,
    );
  }}
  if (!Number.isInteger(bass) || bass < 0 || bass >= N_BASS) {{
    throw new RangeError(`decodeFactored: bass ${{bass}} out of range [0, ${{N_BASS}})`);
  }}
  if (quality === QUALITY_N_INDEX) return N_LABEL;
  const rootStr = ROOTS[root];
  const qualityStr = QUALITY_LABELS[quality];
  const label = `${{rootStr}}:${{qualityStr}}`;
  if (bass === BASS_SAME_INDEX || bass === BASS_N_INDEX) return label;
  return `${{label}}/${{SEMITONES_TO_HARTE[bass]}}`;
}}

/**
 * True for anything ``encodeFactored`` can parse plus the ``"X"`` sentinel.
 * (``"N"`` returns true because it encodes to the N-chord slot.)
 */
export function isValidHarte(s: string): boolean {{
  if (typeof s !== "string") return false;
  if (s === X_LABEL) return true;
  return encodeFactored(s) !== null;
}}

// ---------------------------------------------------------------------------
// Legacy flat-60 API — preserved for PR-Y1.5a smoother/viterbi callers.
// New code should use the factored API above.
// ---------------------------------------------------------------------------

const LEGACY_ENHARMONIC: Readonly<Record<string, string>> = Object.freeze({{
  Db: "C#",
  Eb: "D#",
  Gb: "F#",
  Ab: "G#",
  Bb: "A#",
  Cb: "B",
  Fb: "E",
  "E#": "F",
  "B#": "C",
}});

const LEGACY_ROOT_RE = /^[A-G](?:#|b)?$/;

/** Canonical sharp spelling of a Harte root token; null on malformed input. */
export function canonicalRoot(root: string): string | null {{
  if (typeof root !== "string") return null;
  if (!LEGACY_ROOT_RE.test(root)) return null;
  if (ROOTS.includes(root)) return root;
  return LEGACY_ENHARMONIC[root] ?? null;
}}

const LEGACY_LABEL_TO_INDEX: ReadonlyMap<string, number> = new Map(
  labels.slice(0, 60).map((l, i) => [l, i] as const),
);

/**
 * Index of a Harte label in the legacy 60-label alphabet, or -1 if absent.
 * Accepts flat spellings via enharmonic normalisation. Does NOT accept
 * ``N`` or ``X`` (they sit outside the chord range).
 */
export function labelIndex(harte: string): number {{
  if (typeof harte !== "string" || harte.length === 0) return -1;
  const colon = harte.indexOf(":");
  if (colon < 0) return -1;
  const root = canonicalRoot(harte.slice(0, colon));
  if (!root) return -1;
  const canonical = `${{root}}:${{harte.slice(colon + 1)}}`;
  const idx = LEGACY_LABEL_TO_INDEX.get(canonical);
  return idx === undefined ? -1 : idx;
}}

/** Inverse of ``labelIndex``. Throws on out-of-range index. */
export function labelAt(index: number): string {{
  if (!Number.isInteger(index) || index < 0 || index >= 60) {{
    throw new RangeError(`labelAt: index ${{index}} out of range [0, 60)`);
  }}
  return labels[index];
}}

// ---------------------------------------------------------------------------
// Runtime SHA assertion — closes the "ONNX decoded with wrong alphabet" door.
// ---------------------------------------------------------------------------

/** Shape of the alphabet JSON fixture at ``/alphabet.v1.5.json``. */
export interface AlphabetFixture {{
  readonly alphabet_version: string;
  readonly alphabet_sha: string;
}}

export class AlphabetDriftError extends Error {{
  readonly expected: string;
  readonly got: string;
  constructor(expected: string, got: string) {{
    super(
      `Alphabet SHA drift: bundled TS has ${{expected}}, fixture has ${{got}}. ` +
        "Refusing to run ONNX chord inference against a mismatched alphabet.",
    );
    this.name = "AlphabetDriftError";
    this.expected = expected;
    this.got = got;
  }}
}}

/**
 * Fetch ``/alphabet.v1.5.json`` and verify its ``alphabet_sha`` matches the
 * bundled ``ALPHABET_SHA`` constant. Call this at ONNX session construction
 * time; throw an ``AlphabetDriftError`` to refuse inference on drift.
 *
 * ``fetchFn`` defaults to the global ``fetch`` so tests can inject a stub.
 * ``path`` defaults to the public-root path the generator emits.
 */
export async function assertAlphabetSha(
  fetchFn: typeof fetch = fetch,
  path: string = "/alphabet.v1.5.json",
): Promise<void> {{
  let res: Response;
  try {{
    res = await fetchFn(path);
  }} catch (err) {{
    throw new AlphabetDriftError(ALPHABET_SHA, "(fetch failed)");
  }}
  if (!res.ok) {{
    throw new AlphabetDriftError(ALPHABET_SHA, `(http ${{res.status}})`);
  }}
  const data = (await res.json()) as AlphabetFixture;
  if (!data || typeof data.alphabet_sha !== "string") {{
    throw new AlphabetDriftError(ALPHABET_SHA, "(malformed fixture)");
  }}
  if (data.alphabet_sha !== ALPHABET_SHA) {{
    throw new AlphabetDriftError(ALPHABET_SHA, data.alphabet_sha);
  }}
}}
"""


def render_json(data: AlphabetData, sha: str) -> str:
    """Render the runtime JSON fixture. Pretty-printed, newline-terminated."""
    payload: dict[str, Any] = {
        "alphabet_version": ALPHABET_VERSION,
        "alphabet_sha": sha,
        "roots": list(data.roots),
        "quality_labels": list(data.quality_labels),
        "bass_labels": list(data.bass_labels),
        "quality_n_index": data.quality_n_index,
        "bass_same_index": data.bass_same_index,
        "bass_n_index": data.bass_n_index,
        "legacy_qualities": list(data.legacy_qualities),
        "legacy_labels": list(data.legacy_labels),
        "legacy_n_index": data.legacy_n_index,
        "legacy_x_index": data.legacy_x_index,
    }
    return json.dumps(payload, indent=2, sort_keys=False) + "\n"


# ---------------------------------------------------------------------------
# SHA cross-validation
# ---------------------------------------------------------------------------

_TS_SHA_RE = re.compile(r'export\s+const\s+ALPHABET_SHA\s*=\s*"([0-9a-fA-F]{64})"\s*;')


def parse_ts_sha(ts_text: str) -> str | None:
    """Extract the ``ALPHABET_SHA`` literal from a TS file, or None on absent."""
    m = _TS_SHA_RE.search(ts_text)
    return m.group(1) if m else None


def parse_json_sha(json_text: str) -> str | None:
    """Extract the ``alphabet_sha`` value from a JSON fixture, or None."""
    try:
        data = json.loads(json_text)
    except json.JSONDecodeError:
        return None
    sha = data.get("alphabet_sha")
    return sha if isinstance(sha, str) else None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _print_diff_hint(label: str, on_disk: str, rendered: str, max_chars: int = 500) -> None:
    """Print a short preview of the mismatch to stderr."""
    print(f"  {label}: on-disk len={len(on_disk)}, rendered len={len(rendered)}", file=sys.stderr)
    # Find first diverging line.
    on_lines = on_disk.splitlines()
    new_lines = rendered.splitlines()
    for i, (a, b) in enumerate(zip(on_lines, new_lines, strict=False)):
        if a != b:
            print(f"  first diff at line {i + 1}:", file=sys.stderr)
            print(f"    on-disk:  {a[:max_chars]}", file=sys.stderr)
            print(f"    rendered: {b[:max_chars]}", file=sys.stderr)
            return
    if len(on_lines) != len(new_lines):
        print(
            f"  line count differs: on-disk={len(on_lines)} rendered={len(new_lines)}",
            file=sys.stderr,
        )


def _cross_validate(
    data: AlphabetData,
    computed_sha: str,
    rendered_ts: str,
    rendered_json: str,
) -> None:
    """Assert the Python module and the rendered outputs all agree on SHA."""
    if computed_sha != data.module_alphabet_sha:
        raise SystemExit(
            "codegen_alphabet: Python module's ALPHABET_SHA does not match the "
            f"SHA recomputed from its label lists.\n"
            f"  module ALPHABET_SHA = {data.module_alphabet_sha}\n"
            f"  recomputed          = {computed_sha}\n"
            "Fix: ensure apps/training/model/alphabet.py's _compute_alphabet_sha "
            "payload matches this generator's compute_sha payload."
        )
    ts_sha = parse_ts_sha(rendered_ts)
    if ts_sha != computed_sha:
        raise SystemExit(
            "codegen_alphabet: rendered TS file's ALPHABET_SHA literal does "
            f"not match the recomputed SHA.\n"
            f"  TS literal  = {ts_sha}\n"
            f"  recomputed  = {computed_sha}"
        )
    json_sha = parse_json_sha(rendered_json)
    if json_sha != computed_sha:
        raise SystemExit(
            "codegen_alphabet: rendered JSON fixture's alphabet_sha does not "
            f"match the recomputed SHA.\n"
            f"  JSON field = {json_sha}\n"
            f"  recomputed = {computed_sha}"
        )


def generate(
    source_path: Path,
) -> tuple[AlphabetData, str, str, str]:
    """Core: read source, recompute SHA, render TS + JSON. No I/O side effects."""
    data = read_alphabet(source_path)
    sha = compute_sha(data)
    ts = render_typescript(data, sha)
    js = render_json(data, sha)
    _cross_validate(data, sha, ts, js)
    return data, sha, ts, js


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Codegen: emit apps/web/src/chord/alphabet.ts and "
        "apps/web/public/alphabet.v1.5.json from apps/training/model/alphabet.py."
    )
    parser.add_argument(
        "--from",
        dest="source",
        type=Path,
        default=DEFAULT_SOURCE,
        help="Path to the canonical alphabet.py. " "Default: apps/training/model/alphabet.py.",
    )
    parser.add_argument(
        "--ts-out",
        type=Path,
        default=DEFAULT_TS_OUT,
        help="Path to emit the TypeScript mirror. " "Default: apps/web/src/chord/alphabet.ts.",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=DEFAULT_JSON_OUT,
        help="Path to emit the runtime JSON fixture. "
        "Default: apps/web/public/alphabet.v1.5.json.",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Exit non-zero if files on disk differ from what would be emitted. "
        "Used by the alphabet-mirror-sync CI job.",
    )
    args = parser.parse_args(argv)

    source_path: Path = args.source
    ts_out: Path = args.ts_out
    json_out: Path = args.json_out

    _, sha, rendered_ts, rendered_json = generate(source_path)

    if args.check_only:
        drift = False
        if not ts_out.is_file():
            print(f"codegen_alphabet: {ts_out} missing on disk", file=sys.stderr)
            drift = True
        else:
            on_disk_ts = ts_out.read_text(encoding="utf-8")
            if on_disk_ts != rendered_ts:
                print(
                    f"codegen_alphabet: {ts_out} is out of sync with "
                    f"{source_path}. Run `python scripts/codegen_alphabet.py` "
                    "and commit.",
                    file=sys.stderr,
                )
                _print_diff_hint("TS", on_disk_ts, rendered_ts)
                drift = True
            else:
                on_disk_sha = parse_ts_sha(on_disk_ts)
                if on_disk_sha != sha:
                    print(
                        f"codegen_alphabet: {ts_out} has ALPHABET_SHA="
                        f"{on_disk_sha} but canonical is {sha}. This can only "
                        "happen if the file was hand-edited after codegen.",
                        file=sys.stderr,
                    )
                    drift = True

        if not json_out.is_file():
            print(f"codegen_alphabet: {json_out} missing on disk", file=sys.stderr)
            drift = True
        else:
            on_disk_json = json_out.read_text(encoding="utf-8")
            if on_disk_json != rendered_json:
                print(
                    f"codegen_alphabet: {json_out} is out of sync with "
                    f"{source_path}. Run `python scripts/codegen_alphabet.py` "
                    "and commit.",
                    file=sys.stderr,
                )
                _print_diff_hint("JSON", on_disk_json, rendered_json)
                drift = True
            else:
                on_disk_json_sha = parse_json_sha(on_disk_json)
                if on_disk_json_sha != sha:
                    print(
                        f"codegen_alphabet: {json_out} has alphabet_sha="
                        f"{on_disk_json_sha} but canonical is {sha}.",
                        file=sys.stderr,
                    )
                    drift = True
        if drift:
            return 2
        print(f"codegen_alphabet: in sync (ALPHABET_SHA={sha})")
        return 0

    ts_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.parent.mkdir(parents=True, exist_ok=True)
    ts_out.write_text(rendered_ts, encoding="utf-8")
    json_out.write_text(rendered_json, encoding="utf-8")
    print(f"codegen_alphabet: wrote {ts_out} and {json_out} " f"(ALPHABET_SHA={sha})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
