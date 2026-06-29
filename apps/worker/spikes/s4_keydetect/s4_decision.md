# S4 Decision Record — Key-Detection Library

## Footprint (MEASURED)
| Library | Marginal cost in worker image | Notes |
|---|---|---|
| **librosa** | **~0 MB** | already a worker dependency for BPM; key via Krumhansl-Schmuckler on its chroma |
| **essentia** | wheel ~14 MB → **~40–50 MB installed** | cp312 wheel exists, but see fragility below |

essentia version fragility (real blocker observed): the PRD/TSD-pinned `essentia==2.1b6.dev1110`
**does not exist for Python 3.12** — pip offers only scattered dev builds (`…dev90/184/234/1389`).
The nearest installable build (`2.1b6.dev1389`) has a cp312 wheel. So essentia means pinning a
platform-specific dev build and re-checking it on every Python/OS bump. librosa has stable releases.

## Key accuracy (MEASURED on synthetic samples — see `s4_results.json`)
| Sample | Intended | librosa detected | Note |
|---|---|---|---|
| labeled_song | (multi-section, no single key) | C major | reasonable — track contains C-E-G material |
| neosoul_keys | A minor | **C major** | pitch-class correct; picked the **relative major** |

⚠️ This reproduces the **known librosa weakness** (PRD §7: "BPM good, key weak"): chroma-only
Krumhansl-Schmuckler nails the pitch-class set but is weak at major/minor (relative-key) discrimination.
Measured on **synthetic** pure-tone chords, which are deliberately tonally ambiguous — not a verdict on
real audio. Operator should confirm on a real neo-soul track.

## keys→piano mapping
htdemucs_6s emits a `piano` stem for what the PRD calls `keys`; the contract maps **piano → keys** in
the UI/DB. Captured in `s4_results.json`.

## Decision
[ ] A: librosa (zero added dependency)
[ ] B: essentia (heavier, version-fragile, potentially better key)

## Developer recommendation
**librosa (A).** Zero footprint, stable releases, adequate for the bedroom-producer use case. The
relative-major/minor weakness is a known, bounded limitation; if real-track key accuracy proves
insufficient, revisit essentia (`2.1b6.dev1389`) or a dedicated key model as a targeted upgrade — don't
pay the footprint/fragility cost up front (YAGNI).

## Operator actions to open this gate
1. Confirm keys→piano mapping is musically acceptable on the real neo-soul sample.
2. Judge librosa key accuracy on real labeled audio; pick A or B.

## Gate 0 Status
[ ] APPROVED by operator
