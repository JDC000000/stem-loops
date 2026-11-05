# CQT plan v1 → v2 migration

This note explains the v1 → v2 bump of the pinned CQT plan
(`apps/training/model/cqt_plan.py`).

- **v1 manifest**: `cqt-plan.v1.json`
  (sha256 `1bb5302dd5f29c6f7551f6fca96b07d15d180c102875e7d25cdde6f53aedf8ed`)
- **v2 manifest**: `cqt-plan.v2.json`
  (sha256 `2ecedcb2a237081d7758b42bd8068643f67d0d8d892a4625af7a0a4e53758ba0`)
- **Decision record** that drove the v1 recipe:
  `claude/phase-2-y1-chord-model-decision.md`
- **Red-team brief** that flagged the three defects fixed here:
  `claude/phase-2-y1-chord-model-redteam-alphabet-cqt.md`

## TL;DR

> The v2 plan fixes three CQT defects the alphabet+CQT red-team flagged
> after v1 shipped. Expected lift is **2–4 pts WCSR** (red-team estimate).
> v2 is **not** on-the-wire compatible with v1-trained models — any
> ChordNet checkpoint trained on v1 CQTs must be retrained before it can
> be scored with v2 inputs. Both manifests are kept for A/B comparisons.

## What changed

| Field         | v1       | v2            | Why                                             |
| ------------- | -------- | ------------- | ----------------------------------------------- |
| `hop_length`  | `2048`   | `1024`        | Frame rate 10.77 Hz → 21.53 Hz. SheetSage2 and ChordFormer both use ≤1024; coarse hops smear chord boundaries between frames on fast material. |
| `z_norm`      | `global` | `per_song`    | All three peer systems (SheetSage2, ChordFormer, BTC) use per-song. Dynamic range varies ~40 dB between acoustic folk and death metal; a global z-norm crushes the quiet material. |
| `hpf_hz`      | *(n/a)*  | `70.0`        | **NEW.** 4th-order Butterworth high-pass applied before the CQT. ChordFormer uses the same 70 Hz corner to remove sub-bass rumble that carries no chord-identifying information. Applied zero-phase via `scipy.signal.sosfiltfilt`. |
| `version`     | `"v1"`   | `"v2"`        | Schema bump. Breaking change. |

Fields deliberately left unchanged in v2: `sample_rate` (22050),
`fmin_hz` (32.70 = C1), `n_bins` (144), `bins_per_octave` (24),
`log_amplitude` (True).

## Why we did NOT adopt the fmin C1 → E1 suggestion

The red team also suggested bumping `fmin_hz` from C1 (32.70 Hz) to E1
(41.20 Hz) to save 4 bins. We did not adopt it in v2:

1. **Jazz tracks in McGill Billboard have upright bass below E1.** The
   McGill Billboard annotated corpus includes jazz standards where the
   double bass plays open E (41.20 Hz) and sometimes dips a semitone
   below on walking lines. Truncating the fundamental range risks
   silencing the bass note on exactly the material where the bass is the
   most reliable chord-root cue.
2. **4 bins is not a meaningful saving.** 144 → 140 bins is ~2.8 % of
   the CQT matrix. Browser-side inference latency is dominated by the
   convolutional stack, not the input slice.
3. **The red-team brief explicitly flagged this as the weakest of the
   four suggestions.** It is logged here as "considered, declined, with
   reasons" so a future reader does not re-litigate.

If a later ablation shows the bottom octave is uninformative for our
mix, revisit in v3 with evidence — not in v2 on priors.

## What this breaks

1. **Any v1-trained checkpoint cannot be scored with v2 CQTs.** The
   trained conv stack saw 10.77 Hz frames with global-normalized,
   un-filtered inputs; a v2 input has a different frame rate, different
   amplitude distribution, and HPF-shaped low frequencies. Shape doesn't
   catch this — the hop halves, so a 60 s clip now produces ~2× as many
   frames, and the first layer's receptive field spans half the audio
   seconds it used to.
2. **The sha256 embedded in a checkpoint sidecar shifts.** If any
   checkpoint shipped with v1's sha256 in its metadata, loading it with
   v2 will raise `ValueError: CQT plan sha256 mismatch: ...` at
   `read_manifest` time. That is the loud-failure mode and is
   working-as-intended.
3. **Any downstream file that references `cqt-plan.v1.json` by path
   keeps working** (the file is retained). PR-Y1.6 (browser-side CQT)
   will add `cqt-plan.v2.json` to `apps/web/public/` and switch its
   reader to v2 in a follow-up; until then, the browser side has
   nothing to update.

## What to do if you had a v1 model

1. Rerun the Y1 training with the v2 plan. The synthetic renderer
   (`apps/training/data/synthetic_render.py`) and pitch-shift
   augmentation (`apps/training/data/pitch_shift_aug.py`) are both
   unchanged — only the CQT step they feed is different, and the trainer
   picks up the new plan automatically through `training.model.cqt_plan.PLAN`.
2. Write the new checkpoint sidecar with
   `write_manifest(PLAN, "<run_dir>/cqt-plan.v2.json")` and the v2 sha256
   embedded.
3. Keep the v1 checkpoint around for A/B eval. Our `deserialize_plan`
   accepts v1 JSON payloads (the `hpf_hz` field is defaulted to `0.0`
   when absent so round-tripping a v1 manifest reproduces v1 behaviour
   byte-for-byte).

## Backward-compat tooling

- `read_manifest("cqt-plan.v1.json")` returns a `CQTPlan` with
  `version == "v1"`, `hop_length == 2048`, `z_norm == "global"`,
  `hpf_hz == 0.0`. The current `PLAN` is NOT equal to it; use the
  rehydrated plan as the argument to `librosa_cqt` to reproduce v1
  outputs.
- `plan_sha256(v1_plan)` still equals the sha256 recorded in
  `cqt-plan.v1.json` (serialization of a v1 plan omits `hpf_hz` to keep
  the on-disk payload byte-stable across the code change).
- `test_v1_v2_a_b` in `tests/test_cqt_plan.py` is a working example of
  running the same audio through both plans.
