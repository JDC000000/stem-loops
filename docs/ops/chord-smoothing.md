# Chord-label smoothing (JS-side Viterbi)

## Why this exists

The phase-2 Y1 chord-model pre-mortem flagged **"CRF ONNX export fails"** as the
#1 failure mode for the on-device chord head (HIGH probability × HIGH impact).
If `torch.onnx.export` on the structured + CRF layer can't be made to work
inside the ChordNet training run, we need a Plan B that keeps the rest of the
pipeline usable.

This directory (`apps/web/src/chord/`) is that Plan B — a classical Viterbi
decoder + a music-theory transition matrix over the 60-label Harte alphabet,
in pure TypeScript with zero npm dependencies.

It also pays for itself independent of the hedge: **the current Klangio code
path emits one chord label per beat with no temporal smoothing**, so single-
beat prediction errors show up as visible glitches on the loop view. Feeding
Klangio's output through `smoothChordSequence` before display cleans those up
at essentially no cost.

## Public API

| Module | Export | Purpose |
|---|---|---|
| `viterbi.ts` | `viterbi({logits, nFrames, nStates, transition, startProb?})` | Generic log-domain Viterbi decoder. Not chord-specific. |
| `alphabet.ts` | `labels`, `labelIndex`, `labelAt`, `isValidHarte`, `NUM_LABELS` | The 60-label Harte alphabet: `12 roots × 5 qualities` (maj, min, 7, maj7, min7). `N` and `X` are sentinels outside the 60. |
| `transition.ts` | `defaultTransition()`, `buildTransition({...})`, `loadTransition(path)` | 60×60 log-prob transition matrix with music-theory priors. |
| `smoother.ts` | `smoothChordSequence(labels, confidences?, stickiness?)` | High-level wrapper: labels in, smoothed labels out. |

## Example — cleaning Klangio per-beat output

```ts
import { smoothChordSequence } from '@/chord/smoother';

// Klangio gave us one chord per beat and we have a confidence for each.
const raw         = ['C:maj', 'C:maj', 'G:maj', 'C:maj', 'C:maj', 'F:maj', ...];
const confidences = [0.92,    0.88,    0.41,    0.90,    0.87,    0.93,    ...];

const smoothed = smoothChordSequence(raw, confidences);
// → ['C:maj', 'C:maj', 'C:maj', 'C:maj', 'C:maj', 'F:maj', ...]
// Low-confidence single-frame flip to G:maj got smoothed away.
```

## Example — on-device ONNX fallback (H-3 role)

The intent, if PR-Y1.6's CRF export fails: run the chord-recognition ONNX
model's **emissions only** in ORT Web, then decode with this file's Viterbi.

```ts
import { viterbi } from '@/chord/viterbi';
import { defaultTransition } from '@/chord/transition';
import { labelAt, NUM_LABELS } from '@/chord/alphabet';

// Logits come back from ORT Web as a flat Float32Array (nFrames * 60).
const { path } = viterbi({
  logits: oriLogits,                 // zero-copy from the tensor
  nFrames,
  nStates: NUM_LABELS,
  transition: defaultTransition(),
});
const chordLabels = Array.from(path, labelAt);
```

## Transition matrix

The default matrix rewards:

- **Self** (same root, same quality): prior 0.95
- **Diatonic** (any other label whose root interval from the current root is
  in `{0, 2, 3, 4, 5, 7, 8, 9, 10}` — i.e. anything that is NOT a semitone,
  tritone, or major-seventh away): prior 0.01
- **Unrelated** (root interval ∈ `{1, 6, 11}`): prior 0.001

Each row is normalised so the probabilities sum to 1, then stored in log form.
`buildTransition({selfProb, diatonicProb, unrelatedProb})` exposes the knobs if
a downstream caller wants to retune.

The `N` / `X` sentinel labels do not live inside the 60×60 matrix — the
smoother treats them as uniform-emission passthroughs so the Viterbi path
never spends state on them.

## Alphabet sync (TODO)

Until PR-Y1.7 generates `alphabet.ts` from `apps/training/model/alphabet.py`
(PR-Y1.4), the two files **must be edited in lockstep**. The TODO comment at
the top of `alphabet.ts` is the canonical reminder.

## Testing

Tests live under `apps/web/src/chord/__tests__/` and use the project's
standard runner — `node --experimental-strip-types --test` with `node:test`
and `node:assert/strict`. They run as part of `pnpm --filter web test`.

## Bundle impact

The compiled JS of the four modules combined is well under the 5 kB
minified-size budget called out in the task brief. No runtime dependencies
are added; everything leans on browser-native typed arrays.
