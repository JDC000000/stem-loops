# Synthetic render pipeline

The ChordNet student (V3 Phase 2, Y1) learns on a mix of real-audio corpora
and **synthetic renders** produced from public-domain MusicXML. This page is
the operator's handbook for the synthetic half.

- Code:
  - `apps/training/data/synthetic_render.py` — the renderer.
  - `apps/training/data/pitch_shift_aug.py` — the pitch-shift augmentation.
  - `apps/training/model/cqt_plan.py` — the pinned CQT plan the renders feed.
  - `apps/training/data/download.py` — fetches scores + soundfonts.
- Decision record: `claude/phase-2-y1-chord-model-decision.md` v1.3
  (SheetSage2 synthetic recipe + legal readout).

## Pipeline at a glance

```
PDMX / OpenEWLD MusicXML
     │
     ▼
music21.converter.parse  →  extract <harmony> chord symbols
     │                          │
     ▼                          ▼
score.toStream().write("midi")  Harte .lab (seconds via tempo map)
     │
     ▼
pyFluidSynth @ 24 kHz mono WAV  (soundfont chosen per --soundfont)
     │
     ▼
cache/synthetic/MANIFEST.jsonl   (score_sha, soundfont_sha, licenses, …)
     │
     ▼
pitch_shift_aug.py  (−5..+6 semitones, p = 0.9)
     │
     ▼
Trainer input (CQT per cqt-plan.v2.json)
```

## Soundfont license matrix

Every soundfont rotated through the renderer is permissively licensed. No
proprietary or NC-licensed soundfont enters the rotation.

| Slug                 | License    | Attribution required | Notes |
| -------------------- | ---------- | --------------------- | ----- |
| `fluidr3`            | MIT        | No (credit in release notes) | Default general-MIDI. ~150 MB. |
| `musescore_general`  | MIT        | No (credit in release notes) | MuseScore default. |
| `vsco2`              | CC0-1.0    | No                    | Orchestral; large. |
| `vcsl`               | CC0-1.0    | No                    | Community sample library. |
| `salamander`         | CC-BY-3.0  | **Yes** — "Salamander Grand Piano by Alexander Holm" | Piano-only. |

Any soundfont used at render time has its SHA-256 and license stamped into
`cache/MANIFEST.jsonl`. The weights README generated at open-source release
time cites every soundfont that appears in the manifest, with the
attribution text from `SOUNDFONTS` in `synthetic_render.py`.

## CQT plan versioning

The renders feed a CQT with the parameters pinned in
`apps/training/model/cqt_plan.py`. The current pinned plan is **v2**
(shipped in PR-Y1.3b):

- Sample rate: 22 050 Hz (resampled from the 24 kHz render)
- Hop length: 1024 samples → 21.53 Hz frame rate (**v2**: was 2048)
- Range: C1 (32.70 Hz) → B6, 6 octaves at 24 bins/octave (144 bins)
- Log-amplitude, **per-song z-normalization** (**v2**: was global)
- **HPF 70 Hz** applied before the CQT (**v2**: NEW)

Those values are the model's contract with the browser-side CQT (shipped in
PR-Y1.4). The on-disk manifest `apps/training/model/cqt-plan.v2.json`
carries the plan + a SHA-256 of its canonical JSON; the browser build reads
it at bundle time and fails loudly on mismatch.
`apps/training/model/cqt-plan.v1.json` is retained as a legacy artifact so
v1-trained checkpoints can be scored side-by-side with v2 checkpoints
during the migration. Do not delete it.

**Bumping the plan is a breaking change.** When any field changes:

1. Bump `CQTPlan.version` (e.g. `v2` → `v3`).
2. Write a new manifest under `cqt-plan.v<N>.json` and keep the old one
   until no shipped model still references it.
3. Retrain. The browser CQT must also be rebuilt from the new manifest
   before the new model is served.

### CQT plan v2 migration (PR-Y1.3b)

The alphabet+CQT red-team brief
(`claude/phase-2-y1-chord-model-redteam-alphabet-cqt.md`) flagged three
defects in the v1 plan (shipped in PR #74 / PR-Y1.3):

| Field        | v1       | v2         | Fixes |
| ------------ | -------- | ---------- | ----- |
| `hop_length` | 2048     | 1024       | SheetSage2 / ChordFormer both use ≤1024; coarser hops smear chord boundaries. |
| `z_norm`     | `global` | `per_song` | Peer systems all use per-song; a 40 dB loudness gap across the corpus otherwise crushes quiet tracks. |
| `hpf_hz`     | *(n/a)*  | `70.0`     | ChordFormer's HPF corner. Removes sub-bass rumble that carries no chord-identifying information. |

Expected impact: **+2 to +4 pts WCSR** (red-team estimate). Full detail
and the "considered-but-declined" rationale for the fmin C1 → E1 suggestion
live in `apps/training/model/MIGRATION_NOTE.md`.

**To re-train an existing model under the v2 plan:**

1. Pull PR-Y1.3b and re-run `pip install -e apps/training` to pick up the
   new `scipy>=1.10` dependency (needed for the HPF filter).
2. Re-run the trainer unchanged — `training.model.cqt_plan.PLAN` is now
   the v2 plan, so the training loop picks up the new frame rate, HPF, and
   per-song z-norm automatically.
3. Write the new checkpoint sidecar with
   `write_manifest(PLAN, "<run_dir>/cqt-plan.v2.json")`. The embedded
   sha256 will be `2ecedcb2a237081d7758b42bd8068643f67d0d8d892a4625af7a0a4e53758ba0`.
4. Keep the v1 checkpoint around for A/B eval — `read_manifest()` still
   loads `cqt-plan.v1.json`, and `librosa_cqt(y, v1_plan)` still produces
   bit-identical v1 outputs.

## Adding a new source

1. Add a `DataSource` entry in `apps/training/data/sources.py` with the
   license tag, canonical URL, size, citation, and retrieval notes.
2. Add an entry to `apps/training/DATA-PROVENANCE.md` in the same PR,
   license and citation verbatim, hashes left as `pending`.
3. Wire a `_download_<slug>` function in
   `apps/training/data/download.py` and add it to the `_WIRED` map. The
   transport, hashing, manifest, and resume logic is shared and does not
   need per-source work.
4. If the source is a soundfont (not an annotation corpus), register it in
   the `SOUNDFONTS` dict in `synthetic_render.py` with the license tag and
   the verbatim attribution string. Add a row to the license matrix above.
5. Run `python -m training.data.download --source <slug> --confirm` once
   locally; copy the resulting SHA-256 and timestamp into
   `DATA-PROVENANCE.md` in a follow-up commit on the same PR.

## Running the render

```
# One-off, serial, deterministic:
python -m training.data.synthetic_render \
    --count 1000 \
    --out apps/training/data/cache/synthetic \
    --soundfont fluidr3 \
    --jobs 4 \
    --seed 0
```

Nothing is rendered without first fetching:

- PDMX scores: `python -m training.data.download --source pdmx --confirm`
- OpenEWLD scores: `python -m training.data.download --source openewld --confirm`
- FluidR3 soundfont: `python -m training.data.download --source fluidr3 --confirm`

## Pitch-shift augmentation

After rendering:

```
python -m training.data.pitch_shift_aug \
    --in apps/training/data/cache/synthetic \
    --range -5..+6 \
    --prob 0.9 \
    --seed 42
```

Shifted pairs land under `cache/synthetic/shifted/`. The Harte root
rewriter always resolves to sharps (never flats) on ambiguity; the quality
tag (`:min`, `:maj7`, `:hdim7`, …) and any slash-bass suffix are preserved
verbatim.
