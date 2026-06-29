# Spike Fixtures

Operator-provided test assets for the Phase 0 spikes. These are **not committed**
(audio/binary) unless small and license-clear — see `.gitignore`.

| File | Used by | Provided by | Status |
|---|---|---|---|
| `golden_loop.wav` | S5 (seamlessness) | operator OR `make_synthetic_fixtures.py` | synthetic stand-in committed; swap for a real bar-aligned loop |
| `labeled_song.wav` | S3 / S4 | operator OR `make_synthetic_fixtures.py` | synthetic stand-in committed; swap for a real labeled track |
| `labeled_song_ground_truth.json` | S3 | operator OR generator | synthetic stand-in committed |
| `neosoul_keys.wav` | S4 (keys→piano validation) | operator OR `make_synthetic_fixtures.py` | synthetic stand-in committed |
| `fixture_urls.txt` | S1 (50-URL bake-off) | **operator (required)** | NOT provided — blocks the full S1 measurement |

## Synthetic stand-ins

`make_synthetic_fixtures.py` generates deterministic WAV fixtures (no ffmpeg / no
external audio needed) so S3/S4/S5 spike code is **runnable in CI and on a fresh
checkout**. They validate that the algorithms run and the tests pass — they are NOT
a substitute for measuring musical quality on a real track. Gate 0 sign-off should
use operator-provided real audio where the spike calls for a musical judgement.

Run: `python apps/worker/spikes/fixtures/make_synthetic_fixtures.py`
