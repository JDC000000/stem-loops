#!/usr/bin/env python3
"""Chord-alphabet Python → TypeScript codegen.

Single source of truth: apps/training/model/alphabet.py. Emits
apps/web/src/chord/alphabet.ts (and a Python-computed parity fixture the TS
tests check against). Regenerate with `make alphabet-generate`; CI fails with
ALPHABET DRIFT if the committed output is stale (see `alphabet-drift` job).

Same shape as codegen.py: deterministic, stdlib-only, writes straight to the
committed output path. alphabet.py is loaded by file path so importing it
never pulls in the training package (torch etc.).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
SOURCE_FILE = REPO_ROOT / "apps" / "training" / "model" / "alphabet.py"
OUTPUT_FILE = REPO_ROOT / "apps" / "web" / "src" / "chord" / "alphabet.ts"
FIXTURE_FILE = (
    REPO_ROOT / "apps" / "web" / "src" / "chord" / "__tests__" / "fixtures" / "alphabet-parity.json"
)

# The browser Viterbi smoother, transition matrix and ChordNet ONNX head are
# still a flat 60-state (12 roots x 5 qualities) model. This is the subset of
# the factored quality head those states use, in state order. Every entry is
# asserted to exist in alphabet.QUALITY_LABELS at generation time, so renaming
# or removing one in Python breaks the generator instead of drifting silently.
HMM_QUALITIES: tuple[str, ...] = ("maj", "min", "7", "maj7", "min7")


def _load_alphabet():
    spec = importlib.util.spec_from_file_location("_stemloops_alphabet", SOURCE_FILE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _j(x) -> str:
    return json.dumps(x, ensure_ascii=False)


def _arr(name: str, items) -> str:
    body = ",\n".join(f"  {_j(i)}" for i in items)
    return f"export const {name} = Object.freeze([\n{body},\n] as const);"


def _record(name: str, mapping: dict, value_ts: str) -> str:
    body = "\n".join(f"  {_j(str(k))}: {_j(v)}," for k, v in mapping.items())
    return f"const {name}: Readonly<Record<string, {value_ts}>> = Object.freeze({{\n{body}\n}});"


TEMPLATE_BODY = r'''
export type Root = (typeof ROOTS)[number];
export type QualityLabel = (typeof QUALITY_LABELS)[number];
/** Qualities of the flat 60-state HMM path (subset of QUALITY_LABELS). */
export type Quality = (typeof QUALITIES)[number];

// ─── Runtime mismatch detection ───────────────────────────────────────────

/**
 * Throws if the model/manifest alphabet hash differs from the one this bundle
 * was generated from. Call with the ALPHABET_SHA recorded in the model
 * manifest (training-run manifest / eval report) before trusting its output.
 */
export function assertAlphabetSha(expected: string): void {
  if (expected !== ALPHABET_SHA) {
    throw new Error(
      `chord alphabet mismatch: model=${expected} browser=${ALPHABET_SHA}. ` +
        'Regenerate with `make alphabet-generate` or redeploy the matching model.',
    );
  }
}

// ─── Flat 60-state HMM vocabulary (existing contract — unchanged) ─────────
//
// idx = rootIndex * QUALITIES.length + qualityIndex, 0 = "C:maj".
// N (no-chord) and X (unknown) are NOT in this alphabet; `isValidHarte`
// accepts them, `labelIndex` returns -1 for them.

/** The 60 canonical Harte labels, in index order (0 = "C:maj", 59 = "B:min7"). */
export const labels: readonly string[] = Object.freeze(
  ROOTS.flatMap((r) => QUALITIES.map((q) => `${r}:${q}`)),
);

export const NUM_LABELS = labels.length; // 60

const LABEL_TO_INDEX: ReadonlyMap<string, number> = new Map(
  labels.map((l, i) => [l, i] as const),
);

const ENHARMONIC: Readonly<Record<string, Root>> = Object.freeze({
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
  Cb: 'B',
  Fb: 'E',
  'E#': 'F',
  'B#': 'C',
});

const ROOT_RE = /^[A-G](?:#|b)?$/;

/**
 * Canonicalise a Harte root token to its sharp form. Returns null on anything
 * that is not a valid letter-with-optional-accidental token.
 */
export function canonicalRoot(root: string): Root | null {
  if (!ROOT_RE.test(root)) return null;
  if ((ROOTS as readonly string[]).includes(root)) return root as Root;
  const mapped = ENHARMONIC[root];
  return mapped ?? null;
}

/**
 * Index of a Harte label in the 60-label HMM alphabet, or -1 if not present.
 * Accepts flat spellings on input. Does NOT accept "N" or "X".
 */
export function labelIndex(harte: string): number {
  if (typeof harte !== 'string' || harte.length === 0) return -1;
  const colon = harte.indexOf(':');
  if (colon < 0) return -1;
  const rootRaw = harte.slice(0, colon);
  const quality = harte.slice(colon + 1);
  const root = canonicalRoot(rootRaw);
  if (!root) return -1;
  const idx = LABEL_TO_INDEX.get(`${root}:${quality}`);
  return idx === undefined ? -1 : idx;
}

/** True for any of the 60 Harte labels OR the sentinel labels N and X. */
export function isValidHarte(s: string): boolean {
  if (s === 'N' || s === 'X') return true;
  return labelIndex(s) !== -1;
}

/** Inverse of labelIndex. Throws on out-of-range index (caller should clamp). */
export function labelAt(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= NUM_LABELS) {
    throw new RangeError(`labelAt: index ${index} out of range [0, ${NUM_LABELS})`);
  }
  return labels[index];
}

/** Alias of NUM_LABELS. Preserved for ChordOverlay/chordnet-session callers. */
export const N_CHORD_CLASSES = NUM_LABELS;

/** Alias of labelAt — the chord label for a class index. */
export function chordLabel(cls: number): string {
  return labelAt(cls);
}

/**
 * Up to k nearest chord class indices to `forCls`, excluding itself:
 *   1. same root, different quality
 *   2. same quality, neighbouring roots (fifths/fourths first)
 *   3. other qualities at neighbouring roots
 * Used by the chord-edit popover to show alternatives.
 */
export function nearestChords(forCls: number, k = 10): number[] {
  if (!Number.isInteger(forCls) || forCls < 0 || forCls >= NUM_LABELS) {
    return [];
  }
  const nQualities = QUALITIES.length; // 5
  const rootIdx = Math.floor(forCls / nQualities);
  const qualIdx = forCls % nQualities;
  const out: number[] = [];
  const seen = new Set<number>([forCls]);
  const push = (idx: number) => {
    if (idx >= 0 && idx < NUM_LABELS && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  };
  for (let q = 0; q < nQualities && out.length < k; q++) {
    if (q !== qualIdx) push(rootIdx * nQualities + q);
  }
  const deltas = [5, 7, -5, -7, 2, -2, 1, -1, 3, -3, 4, -4, 6, -6];
  for (const d of deltas) {
    if (out.length >= k) break;
    const r = (((rootIdx + d) % 12) + 12) % 12;
    push(r * nQualities + qualIdx);
  }
  for (let d = 1; d < 12 && out.length < k; d++) {
    for (const sign of [1, -1]) {
      const r = (((rootIdx + sign * d) % 12) + 12) % 12;
      for (let q = 0; q < nQualities && out.length < k; q++) {
        if (q === qualIdx) continue;
        push(r * nQualities + q);
      }
    }
  }
  return out.slice(0, k);
}

// ─── Factored (root, quality, bass) 13 x 25 x 13 — full chord vocabulary ──
//
// Port of alphabet.py encode_factored / decode_factored. Control flow is
// ported by hand; every lookup table above is emitted from Python.

export type FactoredChord = readonly [root: number, quality: number, bass: number];

const NAT_PC: Readonly<Record<string, number>> = Object.freeze({
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
});

function has(table: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function parseRootPc(root: string): number | null {
  if (!root) return null;
  const letter = root[0].toUpperCase();
  if (!has(NAT_PC, letter)) return null;
  let pc = NAT_PC[letter];
  for (const ch of root.slice(1)) {
    if (ch === 'b') pc -= 1;
    else if (ch === '#') pc += 1;
    else return null;
  }
  return ((pc % 12) + 12) % 12;
}

function parseInterval(tok: string): number | null {
  if (!tok) return null;
  let shift = 0;
  let i = 0;
  while (i < tok.length && (tok[i] === 'b' || tok[i] === '#')) {
    shift += tok[i] === 'b' ? -1 : 1;
    i += 1;
  }
  const deg = tok.slice(i);
  if (!has(DEG_SEMITONES, deg)) return null;
  return (((DEG_SEMITONES[deg] + shift) % 12) + 12) % 12;
}

function stripParens(harte: string): [string, string[]] {
  const open = harte.indexOf('(');
  if (open < 0) return [harte, []];
  const rest = harte.slice(open + 1);
  const close = rest.indexOf(')');
  if (close < 0) return [harte, []];
  const extras = rest
    .slice(0, close)
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return [harte.slice(0, open), extras];
}

function extrasEq(extras: readonly string[], ...want: string[]): boolean {
  return extras.length === want.length && extras.every((e, i) => e === want[i]);
}

/**
 * Encode a Harte chord string to (root, quality, bass) indices, or null when
 * it falls outside the 25-quality vocabulary (caller treats as X).
 * "N" -> (ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX). Mirrors Python.
 */
export function encodeFactored(harte: string): FactoredChord | null {
  if (typeof harte !== 'string') return null;
  if (harte === 'N') return [ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX];
  if (harte === 'X') return null;

  let bassTok: string | null = null;
  const slash = harte.indexOf('/');
  if (slash >= 0) {
    bassTok = harte.slice(slash + 1);
    harte = harte.slice(0, slash);
  }

  const [body, extras] = stripParens(harte);
  const colon = body.indexOf(':');
  const rootStr = colon >= 0 ? body.slice(0, colon) : body;
  const shorthand = colon >= 0 ? body.slice(colon + 1) : '';

  const rootPc = parseRootPc(rootStr);
  if (rootPc === null) return null;

  let bassIdx = BASS_SAME_INDEX;
  if (bassTok !== null) {
    const semis = parseInterval(bassTok);
    bassIdx = semis === null || semis === 0 ? BASS_SAME_INDEX : semis;
  }

  let quality: string | null = null;
  const noExtras = extras.length === 0;
  const add9 = extrasEq(extras, '9') || extrasEq(extras, 'add9');
  const add11 = extrasEq(extras, '11') || extrasEq(extras, 'add11');
  if (shorthand === '' && noExtras) quality = 'maj';
  else if (has(FACTORED_SHORTHAND_EXACT, shorthand) && noExtras)
    quality = FACTORED_SHORTHAND_EXACT[shorthand];
  else if (shorthand === 'maj' && add9) quality = 'add9';
  else if (shorthand === 'maj' && add11) quality = 'add11';
  else if (shorthand === 'maj' && extrasEq(extras, '13')) quality = '13';
  else if (shorthand === 'maj6' && add9) quality = 'add6';
  else if (shorthand === 'aug' && extrasEq(extras, 'b7')) quality = 'aug7';
  else if (shorthand === '7') quality = '7';
  else if (has(FACTORED_SHORTHAND_EXACT, shorthand)) quality = FACTORED_SHORTHAND_EXACT[shorthand];
  else if (has(FACTORED_LOSSY_FALLBACK, shorthand)) quality = FACTORED_LOSSY_FALLBACK[shorthand];
  else if (shorthand === '1') quality = '5';
  else return null;

  const qualityIdx = (QUALITY_LABELS as readonly string[]).indexOf(quality);
  if (qualityIdx < 0) return null;
  return [rootPc, qualityIdx, bassIdx];
}

/**
 * Decode (root, quality, bass) to a Harte string. Throws RangeError on
 * out-of-range or degenerate input, exactly where Python raises ValueError.
 */
export function decodeFactored(rootIdx: number, qualityIdx: number, bassIdx: number): string {
  if (!Number.isInteger(rootIdx) || rootIdx < 0 || rootIdx > ROOT_N_INDEX)
    throw new RangeError(`rootIdx ${rootIdx} out of range [0, ${ROOT_N_INDEX}]`);
  if (!Number.isInteger(qualityIdx) || qualityIdx < 0 || qualityIdx >= N_QUALITY)
    throw new RangeError(`qualityIdx ${qualityIdx} out of range [0, ${N_QUALITY})`);
  if (!Number.isInteger(bassIdx) || bassIdx < 0 || bassIdx >= N_BASS)
    throw new RangeError(`bassIdx ${bassIdx} out of range [0, ${N_BASS})`);

  if (qualityIdx === QUALITY_N_INDEX) return 'N';
  if (rootIdx === ROOT_N_INDEX)
    throw new RangeError('rootIdx ROOT_N_INDEX requires qualityIdx === QUALITY_N_INDEX');

  const label = `${ROOTS[rootIdx]}:${QUALITY_LABELS[qualityIdx]}`;
  if (bassIdx === BASS_SAME_INDEX || bassIdx === BASS_N_INDEX) return label;
  return `${label}/${SEMITONES_TO_HARTE[bassIdx]}`;
}
'''


def render(a) -> str:
    for q in HMM_QUALITIES:
        assert q in a.QUALITY_LABELS, f"HMM quality {q!r} no longer in alphabet.QUALITY_LABELS"
    assert a.NUM_ROOTS == len(a.ROOTS) == 12 and a.ROOT_N_INDEX == a.NUM_ROOTS

    out = [
        "// AUTO-GENERATED — DO NOT EDIT",
        "// Source of truth: apps/training/model/alphabet.py",
        "// Regenerate with: make alphabet-generate",
        "// CI fails (alphabet-drift) if this file is stale.",
        "",
        f"export const ALPHABET_SHA = {_j(a.ALPHABET_SHA)};",
        "",
        "// ─── Factored heads (13 root x 25 quality x 13 bass) ───",
        _arr("ROOTS", a.ROOTS),
        f"export const NUM_ROOTS = {a.NUM_ROOTS};",
        f"export const ROOT_N_INDEX = {a.ROOT_N_INDEX};",
        "",
        _arr("QUALITY_LABELS", a.QUALITY_LABELS),
        f"export const N_QUALITY = {a.N_QUALITY};",
        f"export const QUALITY_N_INDEX = {a.QUALITY_N_INDEX};",
        "",
        _arr("BASS_LABELS", a.BASS_LABELS),
        f"export const N_BASS = {a.N_BASS};",
        f"export const BASS_SAME_INDEX = {a.BASS_SAME_INDEX};",
        f"export const BASS_N_INDEX = {a.BASS_N_INDEX};",
        "",
        "// Flat HMM subset of QUALITY_LABELS (see HMM_QUALITIES in the generator).",
        _arr("QUALITIES", HMM_QUALITIES),
        "",
        "// Encode tables (emitted from alphabet.py private tables).",
        _record("FACTORED_SHORTHAND_EXACT", a._FACTORED_SHORTHAND_EXACT, "string"),
        _record("FACTORED_LOSSY_FALLBACK", a._FACTORED_LOSSY_FALLBACK, "string"),
        _record("DEG_SEMITONES", a._DEG_SEMITONES, "number"),
        _record("SEMITONES_TO_HARTE", a._SEMITONES_TO_HARTE, "string"),
    ]
    return "\n".join(out) + "\n" + TEMPLATE_BODY


def fixture(a) -> str:
    """Python-computed ground truth the TS tests compare against."""
    enc_inputs: list[str] = ["N", "X", ""]
    for r in a.ROOTS:
        enc_inputs += [r, f"{r}:maj"]
    for q in a.QUALITY_LABELS[:-1]:
        enc_inputs.append(f"C:{q}")
    enc_inputs += [
        "Db:min7", "Cbb:maj", "F##:7", "c:min", "H:maj", "C:", "C:foo", "C:sus", "C:1",
        "C:maj(9)", "C:maj(add9)", "C:maj(11)", "C:maj(add11)", "C:maj(13)", "C:maj6(9)",
        "C:maj6(add9)", "C:aug(b7)", "C:7(b9)", "C:7(#11,b13)", "C:min7(9)", "C:maj(9,11)",
        "C:maj11", "C:maj13", "C:min11", "C:min13", "C(9)", "C:maj(9", "C:maj(9))",
        "G:7/5", "G:7/b7", "G:7/1", "G:7/3", "G:7/9", "G:7/x", "G:7/", "A:min/b3", "A:min/bb7",
        "E:min7", "A:7", "Bb:7/5", "C:maj/##4", "C:maj/11", " C:maj", "C :maj",
    ]  # fmt: skip
    encode = {s: (list(v) if (v := a.encode_factored(s)) is not None else None) for s in enc_inputs}
    decode = []
    for r in range(a.ROOT_N_INDEX + 1):
        for q in range(a.N_QUALITY):
            for b in range(a.N_BASS):
                try:
                    decode.append([r, q, b, a.decode_factored(r, q, b)])
                except ValueError:
                    decode.append([r, q, b, None])
    return (
        json.dumps(
            {"alphabet_sha": a.ALPHABET_SHA, "encode": encode, "decode": decode},
            indent=1,
            sort_keys=True,
        )
        + "\n"
    )


def main() -> None:
    a = _load_alphabet()
    OUTPUT_FILE.write_text(render(a))
    FIXTURE_FILE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_FILE.write_text(fixture(a))
    print(f"TypeScript alphabet written to {OUTPUT_FILE}")
    print(f"Parity fixture written to {FIXTURE_FILE}")


if __name__ == "__main__":
    main()
