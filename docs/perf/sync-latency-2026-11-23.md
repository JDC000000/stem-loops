# Chord-display sync latency (US 3.4 / V3-J3)

**Date:** 2026-11-23 (round 2, supersedes the round-1 numbers) · **Budget:** chord display vs audio, p95 <= 50 ms (|lag|) · **Raw data (including every raw DOM-change event, so it can be re-paired without a re-run):** [`sync-latency-2026-11-23.results.json`](./sync-latency-2026-11-23.results.json) · **Script:** [`packages/web-browser-gate/scripts/measure-chord-sync-latency.mjs`](../../packages/web-browser-gate/scripts/measure-chord-sync-latency.mjs)

> **US 3.4 / V3-J3 is NOT settled by this run.** This is a first harness measurement on an emulated phone on a saturated shared box. It does not show the 50 ms p95 budget met (headline p95 63.5 ms, budget not met), and it does not show it failed on a real device. Do not mark "sync tolerance measured / met" on the strength of it. Re-run spec below.

No product code changed.

## Result

Chromium 153 (`channel: chrome`, headless), Pixel 7 emulation at 390x844, **4x CPU throttle**, phone route (24 kHz, MediaStream -> `<audio>`, `routeLatencySec` compensation of 50 ms in effect). One sample per chord change on the phone stage's Now element; `|lag|` in ms; positive = the chord appeared after the sound. Whole songs, real time, one run per mode.

**Host load during the run: 1-min load average 6.2 to 11.3 on 2 cores** (6.7 at start, 8.3 at end of the detailed pass). I waited 30 minutes for it to drop below 3 and it never did (5 to 10), so I ran anyway. Treat the tail as inflated by CPU starvation.

### Headline: Simple chord mode (the app default)

| Song | expected / shown / missed | p50 | p95 | max |
|---|---|---|---|---|
| lucky-ticket | 86 / 86 / 0 | 19.4 | 90.8 | 290.7 |
| im-asking-you | 77 / 77 / 0 | 17.1 | 60.3 | 75.0 |
| offline | 74 / 74 / 0 | 15.1 | 54.0 | 500.1 |
| **All three** | **237 / 237 / 0** | **17.7** | **63.5** | **500.1** |

### Secondary: Detailed chord mode (every detected segment)

| Song | expected / shown / missed | p50 | p95 | max |
|---|---|---|---|---|
| lucky-ticket | 200 / 199 / 1 | 14.7 | 56.4 | 231.7 |
| im-asking-you | 153 / 153 / 0 | 16.1 | 55.2 | 112.3 |
| offline | 197 / 196 / 1 | 16.4 | 94.6 | 348.9 |
| **All three** | **550 / 548 / 2** | **15.5** | **77.7** (78.1 counting the 2 misses at their estimated lag) | **348.9** (509.5 for the missed one) |

The two Detailed misses are chords the stage never showed because a stall let the playhead pass them: lucky-ticket 157.5 s (`A`, its successor appeared an estimated 509 ms late) and offline 179.1 s (`G`, estimated 141 ms). They are counted in the "with misses" figure, not dropped.

Other clock models over the same samples (all-song |lag| p95; Simple / Detailed):

| Model | Simple | Detailed |
|---|---|---|
| Render clock only (`ctx.currentTime`; includes the 50 ms compensation, so it cannot be below 50) | 123.8 | 127.2 |
| Heard = render + `getOutputTimestamp()` (includes the context's 32 ms `outputLatency`) | 81.0 | 95.2 |
| **Heard + 17.5 ms MediaStream hop (phone route; headline)** | **63.5** | **77.7** |
| Headline + one 60 Hz frame (16.7 ms) for DOM-change-to-pixels | 80.1 | 94.4 |

Reading the signed values: with production compensation the chord is never shown before the engine reaches start + 50 ms (the render lag is >= 50 ms in every row, min 50.0 in Detailed and 53.1 in Simple). The signed minimum of the headline model is -1.2 ms (Simple) and -6.6 ms (Detailed), inside the +/- 5 ms clock-mapping error. There is no measured "early" tail; the compensation does not over-correct. Round 1 reported an early tail down to -58 ms; that was a pairing bug (a late change credited to the next segment) and is withdrawn, as are round 1's 74.6 / 229.3 figures.

## Method

- Real production modules bundled unchanged: play engine, device rule, background-audio route and `routeLatencySec`, real `PlayerView` and `ChordOverlay` phone stage, real chord loader fed each demo song's `play-chords` payload (`apps/web/test/fixtures/demo-chords/*.json`). Player.tsx's latency wiring (playing edge, `running` statechange, 250 ms and 1 s resamples) is replicated in the harness. The mode comes from the `sl.play.chordMode.v1` localStorage key; the page confirms it (`data-mode` of the stage was `bars` for Simple and `sequence` for Detailed).
- A `MutationObserver` reads the Now-chord element after every DOM mutation. On a text change it records `performance.now()`, `ctx.currentTime`, `ctx.getOutputTimestamp()`, the engine position and the compensation in force, all in one task.
- **Pairing (fixed in round 2).** The overlay shows the position `enginePos - compensation`, so each DOM change is paired with the last expected change whose start is <= `rawPos - comp`, one change per expected change. Expected changes are the start of every shown run whose label differs from the run before: the raw segments in Detailed; in Simple, the output of the production `simplifyChords` run in the page on the same segments, beat grid and section anchors. An expected change with no DOM change is a MISS and is reported. Spurious DOM changes (2 to 3 per song: the first chord at play start and the end of song) are counted, not paired.
- Fixture facts: the three demo fixtures have 0 adjacent same-label segments and the shortest segment is 92.6 ms, so every Detailed segment is an expected change.

## What is and is not included

Included: engine tick (rAF), React render and commit, `routeLatencySec` compensation, main-thread contention under 4x CPU throttle plus a saturated host, the context's reported `outputLatency`, the MediaStream -> `<audio>` hop (the 17.5 ms median from `mobile-player-2026-11-15.latency.json`, not re-measured here).

Not included:
- **Hardware / OS output latency on real phones**, Bluetooth (100-250 ms, unreported by any API), and the `<audio>` element's own sink latency (not exposed to JS). `outputLatency` in headless Chromium is a fixed 32 ms, not a device value.
- **Pixels.** The timestamp is the DOM change; headless Chromium cannot observe presentation. The "+ frame" row bounds it.
- **Safari / WebKit** and real touch hardware: not measured at all.
- **Real demo audio.** Stems are silent Opus of the song's length (demo audio is in R2, out of reach). The engine clock does not depend on content, but real decode memory pressure is not reproduced.
- **The clock mapping is not independently validated** by an audible-click tap on this harness (the 2026-11-15 latency harness did that for the hop only).
- One run per mode: no spread across repeated runs.

## Re-run spec (needed before US 3.4 / V3-J3 can be called measured)

1. Quiet machine: nothing else running, 1-min load < 1. (This run could not get below 5.)
2. Simple mode as the headline, Detailed as secondary, all three demo songs, at least 3 runs each, report the spread.
3. Real Pixel-class Android in Chrome and a real iPhone in Safari (and an Android + a wired / Bluetooth output case), not emulation.
4. Validate the clock mapping with an audible-click tap (a click stem at the segment starts, captured by a microphone or loopback and compared with the DOM-change time and, ideally, a screen-capture frame time), so hardware output latency and presentation are included.
5. Pairing and miss accounting as in this script; save raw events (this script does) so results can be re-derived.

`cd packages/web-browser-gate && node scripts/measure-chord-sync-latency.mjs --out /tmp/out.json [--modes simple,detailed] [--slugs lucky-ticket] [--max-sec 60] [--cpu 4]`

Not wired into CI. Needs Google Chrome (`CHROME_CHANNEL` overrides) and ffmpeg. No assertion test is added: p95 depends on host load, so it would be unstable.
