# Experiment A - Alphabet Collapse Audit on McGill Billboard

**Verdict:** SWITCH + v1.5-bump. Flat-60 demotes **39.04%** of Billboard tokens (> 30% threshold). **SWITCH** to the factored head AND flag the decision record for a v1.5 bump.

**Source:** ChoCo McGill Billboard JAMS (smashub/choco at 5fe168f, CC BY 4.0, 890 songs)
**Bundle sha256:** `6b82b269980315a9ff365fb2a89b33517d42a0cd305501f7e3131c3343cecce5`
**Corpus:** 124,895 chord tokens, 3209.0 minutes of annotated audio

## Table 1 - Token-level outcomes under each alphabet

| Alphabet | Exact | Lossy (collapsed) | X (dropped) | Total |
|---|---|---|---|---|
| Flat 60 | 75,929 (60.79%) | 48,757 (39.04%) | 209 (0.17%) | 124,895 (100%) |
| Factored 25x13 | 117,197 (93.84%) | 7,396 (5.92%) | 302 (0.24%) | 124,895 (100%) |

## Table 2 - Top 20 lossiest input qualities under Flat 60

| Rank | Original quality | Token count | % of corpus | Collapsed to | Information lost |
|---|---|---|---|---|---|
| 1 | `7` | 9,796 | 7.84% | `maj` | 7th-extension |
| 2 | `min7` | 8,645 | 6.92% | `min` | 7th-extension |
| 3 | `maj/5` | 2,647 | 2.12% | `maj` | bass:/5 |
| 4 | `maj7` | 2,644 | 2.12% | `maj` | 7th-extension |
| 5 | `5` | 2,545 | 2.04% | `maj` | power-chord(no-3rd) |
| 6 | `1` | 2,319 | 1.86% | `maj` | unison(no-3rd-no-5th) |
| 7 | `maj/3` | 1,811 | 1.45% | `maj` | bass:/3 |
| 8 | `maj(9)` | 1,266 | 1.01% | `maj` | extras:(9) |
| 9 | `sus4` | 1,262 | 1.01% | `sus` | sus2/sus4-merged |
| 10 | `sus4(b7,9)` | 1,087 | 0.87% | `sus` | sus2/sus4-merged;extras:(b7,9) |
| 11 | `maj/2` | 1,032 | 0.83% | `maj` | bass:/2 |
| 12 | `maj6` | 983 | 0.79% | `maj` | 6th-extension |
| 13 | `sus4(b7)` | 948 | 0.76% | `sus` | sus2/sus4-merged;extras:(b7) |
| 14 | `7(#9)` | 917 | 0.73% | `maj` | 7th-extension;extras:(#9) |
| 15 | `min9` | 873 | 0.70% | `min` | 7th-extension |
| 16 | `maj9` | 625 | 0.50% | `maj` | 7th-extension |
| 17 | `min/b7` | 487 | 0.39% | `min` | bass:/b7 |
| 18 | `maj/4` | 479 | 0.38% | `maj` | bass:/4 |
| 19 | `maj/b7` | 420 | 0.34% | `maj` | bass:/b7 |
| 20 | `11` | 419 | 0.34% | `maj` | 7th-extension |

## Table 2b - Top 10 lossiest input qualities under Factored 25x13

| Rank | Original quality | Token count | % of corpus | Collapsed to | Information lost |
|---|---|---|---|---|---|
| 1 | `1` | 2,319 | 1.86% | `5` | 1(unison)->5:approximated-no-5th-either |
| 2 | `sus4(b7,9)` | 1,087 | 0.87% | `sus4` | sus4(b7,9)->sus4:dropped-b7-and-9 |
| 3 | `sus4(b7)` | 948 | 0.76% | `sus4` | sus4(b7)->sus4:dropped-b7 |
| 4 | `7(#9)` | 917 | 0.73% | `7` | 7(#9)->7:dropped-altered-tensions |
| 5 | `min11` | 260 | 0.21% | `min9` | 11-tension |
| 6 | `5(b7)` | 233 | 0.19% | `5` | 5(b7)->5:dropped-b7 |
| 7 | `maj6(9)` | 220 | 0.18% | `add6` | maj6(9)->add6:dropped-9 |
| 8 | `sus4(9)` | 149 | 0.12% | `sus4` | sus4(9)->sus4:dropped-9 |
| 9 | `min(9)` | 132 | 0.11% | `min` | min(9)->min:dropped-extras |
| 10 | `7(b9)` | 120 | 0.10% | `7` | 7(b9)->7:dropped-altered-tensions |

## Table 3 - Information retained by each alphabet (token-level)

| Alphabet | Exact-match tokens | Preserved share |
|---|---|---|
| Flat 60 | 75,929 / 124,895 | 60.79% |
| Factored 25x13 | 117,197 / 124,895 | 93.84% |
| Full 170-class (baseline) | 124,895 / 124,895 | 100.00% |

## Table 4 - User-visible impact (duration-weighted)

| Alphabet | Exact | Lossy | X |
|---|---|---|---|
| Flat 60 | 60.72% | 39.10% | 0.18% |
| Factored 25x13 | 93.84% | 5.90% | 0.26% |

## Notes

- Source: ChoCo (CC BY 4.0) re-packaging of McGill Billboard chord annotations, which preserve full Harte labels.
- Reproducible via `python scripts/alphabet_collapse_audit.py --jams-dir <path>`.
- See `claude/phase-2-y1-chord-model-redteam-alphabet-cqt.md` for the alphabet definitions and the thresholds this verdict uses.
