# Chord-display sync latency (US 3.4 / V3-J3)

**Date:** 2026-11-23 · **Budget:** chord display vs audio, p95 <= 50 ms (|lag|) · **Raw data:** [`sync-latency-2026-11-23.results.json`](./sync-latency-2026-11-23.results.json) · **Script:** [`packages/web-browser-gate/scripts/measure-chord-sync-latency.mjs`](../../packages/web-browser-gate/scripts/measure-chord-sync-latency.mjs)

First measurement of this number. No product code changed.

## Result (headline row in bold)

Chromium 153 (`channel: chrome`, headless), Pixel 7 emulation at 390x844, **4x CPU throttle**, phone route (24 kHz, MediaStream -> `<audio>`, `routeLatencySec` compensation 50 ms in effect). Each sample is one chord change on the phone stage's Now element, `|lag|` in ms, positive = chord appeared after the sound.

| Song (chord changes timed / expected) | p50 | p95 | max |
|---|---|---|---|
| lucky-ticket (194 / 200) | 16.2 | 86.9 | 229.3 |
| im-asking-you (152 / 153) | 15.7 | 53.9 | 111.9 |
| offline (196 / 197) | 15.6 | 62.0 | 137.4 |
| **All three (542)** | **15.7** | **74.6** | **229.3** |

**p95 does NOT meet 50 ms in this run (74.6 ms overall; 53.9 to 86.9 per song).** The median (15.7 ms) is well inside it. The tail is heavy: the signed range is -57.9 to +229.3 ms.

Other clock models over the same 542 events (abs p50 / p95 / max):

| Model | p50 | p95 | max |
|---|---|---|---|
| Render clock only (`ctx.currentTime`, no output latency, includes the 50 ms compensation) | 71.3 | 127.8 | 280.1 |
| Heard = render clock + `getOutputTimestamp()` (includes the context's 32 ms `outputLatency`) | 33.1 | 92.1 | 246.8 |
| **Heard + MediaStream hop of 17.5 ms (phone route; headline)** | 15.7 | 74.6 | 229.3 |
| Headline + one 60 Hz frame (16.7 ms) for DOM-change-to-pixels | 32.3 | 91.2 | 246.0 |

## Method

- Real production modules bundled unchanged: play engine, device rule, background-audio route and `routeLatencySec`, real `PlayerView` and `ChordOverlay` phone stage, real chord loader fed each demo song's `play-chords` payload (`apps/web/test/fixtures/demo-chords/*.json`, detailed chord mode, every segment shown). Player.tsx's latency wiring (playing edge, `running` statechange, 250 ms and 1 s resamples) is replicated in the harness.
- A `MutationObserver` reads the Now-chord element after every DOM mutation. On a text change it records `performance.now()`, `ctx.currentTime`, `ctx.getOutputTimestamp()` and the engine position in one task. The change is paired with the segment the audio most recently entered (last `start_sec` <= render clock, one change per segment); that `start_sec` is the moment the chord should switch.
- Whole songs played in real time, one per fresh context; one Chromium process.

## What is and is not included

Included: engine tick (rAF), React render and commit, `routeLatencySec` compensation, main-thread contention under 4x CPU throttle, the context's reported `outputLatency`, the measured MediaStream -> `<audio>` hop (taken as the 17.5 ms median from `mobile-player-2026-11-15.latency.json`, not re-measured here).

Not included:
- **Hardware / OS output latency on real phones**, Bluetooth (100-250 ms, unreported by any API), and the `<audio>` element's own sink latency (not exposed to JS). `outputLatency` in headless Chromium is a fixed 32 ms, not a device value.
- **Pixels.** The timestamp is the DOM change; headless Chromium cannot observe presentation. "+ frame" bounds it.
- **Safari / WebKit** (not measured at all) and real touch hardware.
- **Real demo audio.** Stems are silent Opus of the song's length (demo audio is in R2, out of reach). The engine clock is audio-independent, but decode cost and real-stem memory pressure are not reproduced.
- Clock mapping is self-consistent, not independently verified by an audible click tap (the 2026-11-15 latency harness did that for the hop only). Quantum error is about 3-5 ms.
- Simple chord mode (the app default) was not run; detailed mode shows every segment and is the stricter sample.
- 24 chord changes of ~550 expected were not timed: a segment with the same label as its predecessor or shorter than a frame shows no change.

## Confounder: the box was saturated

The host (2 cores) ran at load average 8-12 from other agents during the run, on top of the 4x throttle. The tail (p95 and max) is therefore likely inflated by CPU starvation of the renderer; the median and the sign are more trustworthy. The per-song spread (53.9 to 86.9) tracks which stretch ran during the heaviest load. **Re-run on a quiet machine before treating 74.6 ms as the product's number.** A real mid-range phone is not a 4x-throttled desktop either, in either direction.

## Interpretation

- The compensation is centred: the signed p50 is +15.5 ms (slightly late), with an early tail down to -58 ms (a chord shown before the sound), so the 50 ms compensation is about right on average here.
- The late tail (+100 to +230 ms) is main-thread stalls (the same hitches that would drop frames), not a clock offset.

## Test

No assertion test was added: the p95 depends on host load (this run failed on a saturated box), so it would be unstable. Re-run by hand:

`cd packages/web-browser-gate && node scripts/measure-chord-sync-latency.mjs --out /tmp/out.json [--slugs lucky-ticket] [--max-sec 60] [--cpu 4]`

Not wired into CI. Needs Google Chrome (`CHROME_CHANNEL` overrides) and ffmpeg.
