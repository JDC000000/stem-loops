# Beat alignment eval: do loops start on the beat, at the right tempo?

Grades the worker's real extracting stage (`pipeline.extract_and_tag`) on tracks with known
beats, for any checkout. Run it against the base and against a branch to get before/after.
No audio lives in the repo: generate or fetch it into a scratch data dir.

## What is measured (per loop, 1/2/4-bar)

- **start offset**: loop `start_sec` minus the nearest reference beat (+ = loop starts late).
- **repeat slip**: loop length minus the true duration of the same number of beats at that
  point of the song. That is how far the loop drifts against the original each time it repeats.
- **tempo error**: reported BPM vs the reference tempo, after accounting for the metrical
  level (`1x`, `2x` = double-time, `0.5x` = half-time).
- **on downbeat**: whether the start is within 70 ms of a reference downbeat. This is for
  information only; the worker does not detect downbeats.

## Reference beats

| Source | Used for | Precision (measured) |
|---|---|---|
| `synth.py`: exact beat times | 8 synthetic drum tracks: click, humanized rock 102, swing 92, syncopated 16ths 128, trap half-time 140, DnB 174, rock 77, tempo ramp 99→101 | exact |
| `ground_truth.py beats`: Beat This! (`final0`, ISMIR 2024), an independent neural tracker | real music | Validated on the synthetic set. Tempo within 0.005 BPM. Jitter after local de-quantization ~2 ms. Beats sit **+2 to +13 ms late** (+22 ms on a bare click), so real-track offsets carry about ±15 ms of reference uncertainty. |

Real tracks are graded twice: once with an htdemucs drum stem as the reference stem (what
production does, since `extract_and_tag` prefers drums) and once with the full mix.
**Decode MP3s to WAV once before separating them.** demucs (ffmpeg) and librosa trim the MP3
encoder delay differently, which shifts the stem timeline by 23–25 ms.

## Reproduce

```bash
DATA=/path/outside/repo            # e.g. .scratch/tempofit
python synth.py $DATA/synth        # worker venv (numpy, soundfile)
# real tracks: put WAVs in $DATA/audio/<name>.wav, then in an eval-only venv
# (torch CPU + beat_this + demucs, never the worker image):
python ground_truth.py beats $DATA/audio/*.wav
python ground_truth.py drums $DATA/stems $DATA/audio/*.wav
# grade both versions with the worker venv (requirements.txt + constraints-prod.txt)
STUB_MODE=true python run_eval.py --worker-src <base>/apps/worker/src --data $DATA --label before --out before.json
STUB_MODE=true python run_eval.py --worker-src apps/worker/src --data $DATA --label after --out after.json
python compare.py before.json after.json --exclude jazz_622426 syn_drift_99_to_101
python downbeat_probe.py --worker-src apps/worker/src --data $DATA
python timing.py --worker-src apps/worker/src --ref $DATA/stems/lucky.drums.wav
```

Real tracks used for the October 2026 run:
- Lucky Ticket (Jon Cartwright; owner-provided master, not redistributable)
- Freesound CC0 HQ previews:
  - 523940 *Retro Rocker 120bpm*
  - 537350 *Country Rocker 85 BPM*
  - 703568 *TRAP Type Beat - Dark Time* (half-time, ~70/140)
  - 532828 *70s Style Soul Groovy Loop*
  - 639262 *Retro Party Dance 80s Funk*
  - 622426 *Happy Experimental Ethno Jazz … 120Bpm*

## Results (base `phase-3-ux` cb5eefa vs this branch)

Pooled over 548 loops on the tracks with reliable reference beats (jazz and the
tempo-ramp track are excluded and reported separately below):

| | before | after |
|---|---|---|
| \|start offset\| median | 123 ms | **1.8 ms** |
| \|start offset\| p90 / max | 237 / 387 ms | **12.7 / 38 ms** |
| starts ≤ 30 ms of a beat | 12 % | **99 %** |
| repeat slip, mean / max | 10.6 / 28.0 ms per bar | **1.2 / 20 ms per bar**[^slip] |
| tempo error (same metrical level) | −0.66 … +0.94 % | **≤ 0.04 %** |
| metrical level vs reference | unchanged | unchanged (by design: same tracker picks the level) |

[^slip]: All synthetic tracks measure 0.0 ms. On real tracks the residual is mostly
reference noise: the fitted tempo matches Beat This! to ≤ 0.04 %.

Lucky Ticket goes from 101.33 to **102.00 BPM**. Its loop starts go from 107 ms median
(254 ms max) off the beat to **3 ms (12 ms max)**. Its 4-bar repeat slip goes from 62 ms
to **3.4 ms** per repeat.

Per-track before/after: run `compare.py` (the table is also in the PR description).

## Known limits

- **Downbeat / bar 1 is not detected.** Loops start on a beat. "Bar 1" is just the first
  detected beat. A kick plus harmony-change probe (`downbeat_probe.py`) matched the
  reference bar phase on only 8 of 13 tracks, so it is not used. On Lucky Ticket, Beat This!
  (99 % self-consistent) puts the bar line one beat after our anchor, so its loops are on the
  beat but not on bar 1.
- **Half/double time is inherited** from librosa's tracker, deliberately unchanged:
  - rock 77 is reported as 154, a pre-existing behaviour.
  - DnB 174 is reported as 87.
  - Country 85 and trap 70 are correct.

  Starts and lengths are still beat-exact at the reported level.
- **Tempo drift** (live playing without a click): the grid is constant-tempo. On a ±1 %
  ramp, starts improve from 200 to 90 ms median, but slip stays about 17 ms per bar. A
  constant-length loop can't follow a drifting tempo.
- **No steady pulse** (the "ethno jazz" track): Beat This! itself returns 17–273 BPM
  intervals there, so there is no ground truth. The tempo changes from 117.45 to 115.00
  (drum stem) and from 147.66 to 149.93 (mix). Excluded from the totals.
- The onset-latency calibration (9 ms) was fitted on the synthetic set. Real tracks are
  the out-of-sample check.
