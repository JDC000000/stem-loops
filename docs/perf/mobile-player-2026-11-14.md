# Mobile player: memory and decode measurement (Story 8.3)

**Date:** 2026-11-14 · **Branch:** `feat/mobile-player-state` · **Raw data:** [`mobile-player-2026-11-14.results.json`](./mobile-player-2026-11-14.results.json) · **Harness:** [`scripts/perf/mobile-player/`](../../scripts/perf/mobile-player/)

## Summary

- **This does not show that the player works on a phone, and it does not show that it fails on one.** Device emulation in desktop Chromium changes the viewport, the user agent, touch input and the pointer media queries. It does **not** change the memory limit, the CPU, the codec path or the tab-discard policy. So the memory figures below are desktop-Chromium figures. They are the same whichever device profile is emulated, which is expected.
- **The load peak at the shipped config (6 stems × 300 s, 48 kHz mono) is about 720 MiB** in the renderer process (VmHWM: median 723, range 667–724, over 9 runs across 3 profiles). It settles at about 490 MiB.
- **24 kHz cuts the peak by about 160 MiB (to about 560 MiB) and the settled figure by about 165 MiB (to about 325 MiB).** The PCM halves, but the peak does not, because the `decodeAudioData` transient is not PCM-sized (see engine.ts MEMORY).
- **A 120 s song at 48 kHz peaks at about 390 MiB.** That is lower than 300 s at 24 kHz. Song length is the bigger lever.
- **Decode wall time on this host was 17–24 s at 300 s/48 kHz, and 24 kHz was *slower* (22–33 s).** The resample to 24 kHz costs CPU. These times were taken on a 2-core VM shared with other build jobs (load average 12–18), so treat them as relative, not absolute.
- **Nothing in this PR changes the engine, `PLAYBACK_SAMPLE_RATE` or `MAX_TRACK_SEC`.** The 24 kHz arm is driven by injecting the context rate through the engine's existing `createAudioContext` option.
- **Decision for Jon (not taken here):** whether to (a) keep phones on the "not yet" state shipped in this PR, (b) measure on a real phone first (method below, using `?player=force`), or (c) adopt one of the levers (24 kHz, a lower length cap on phones, fewer stems, or streaming decode).

## Results

Renderer process only. MiB = 2²⁰ bytes. Each cell is min–max (median) over 3 runs, with a fresh browser for each run. Every run finished with `status: ready` and 6/6 stems. No run crashed.

| Profile | Song (s) | Rate (kHz) | Mono PCM (MiB) | Decode time (ms) | **Peak RSS, VmHWM (MiB)** | Settled RSS (MiB) | JS heap used (MiB) |
|---|---|---|---|---|---|---|---|
| Desktop Chrome (baseline) | 300 | 48 | 329.6 | 20,917–23,932 (23,176) | **668–723 (722)** | 488–490 (489) | 0.8 |
| Desktop Chrome (baseline) | 300 | 24 | 164.8 | 27,103–32,367 (28,989) | **550–585 (559)** | 319–326 (324) | 0.8 |
| Desktop Chrome (baseline) | 120 | 48 | 131.8 | 8,755–11,270 (11,236) | **388–392 (389)** | 272–277 (273) | 0.8 |
| Desktop Chrome (baseline) | 120 | 24 | 65.9 | 11,298–14,544 (12,472) | **309–313 (310)** | 206–208 (206) | 0.8 |
| Pixel 7 (emulated) | 300 | 48 | 329.6 | 18,504–23,621 (20,693) | **667–723 (722)** | 489–491 (490) | 0.9 |
| Pixel 7 (emulated) | 300 | 24 | 164.8 | 21,973–32,780 (23,414) | **557–586 (558)** | 324–326 (326) | 0.9 |
| Pixel 7 (emulated) | 120 | 48 | 131.8 | 9,836–12,073 (10,000) | **366–410 (390)** | 273–275 (274) | 0.9 |
| Pixel 7 (emulated) | 120 | 24 | 65.9 | 9,422–11,751 (10,672) | **333–337 (335)** | 207–210 (209) | 0.9 |
| iPhone 14 (emulated on Chromium) | 300 | 48 | 329.6 | 16,688–20,675 (18,651) | **723–724 (723)** | 490–491 (490) | 0.9 |
| iPhone 14 (emulated on Chromium) | 300 | 24 | 164.8 | 23,323–25,270 (23,379) | **531–585 (585)** | 325–326 (325) | 0.9 |
| iPhone 14 (emulated on Chromium) | 120 | 48 | 131.8 | 5,620–8,027 (6,612) | **411–455 (454)** | 273–276 (274) | 0.9 |
| iPhone 14 (emulated on Chromium) | 120 | 24 | 65.9 | 7,737–10,353 (8,242) | **332–336 (333)** | 207–211 (208) | 0.8 |

### Pooled across the three profiles (n = 9 per row)

| Config | Peak RSS median (MiB) | Settled RSS median (MiB) | vs shipped peak |
|---|---|---|---|
| **300 s, 48 kHz (shipped)** | **723** | **490** | — |
| 300 s, 24 kHz | 559 | 325 | −164 |
| 120 s, 48 kHz | 392 | 274 | −331 |
| 120 s, 24 kHz | 333 | 208 | −390 |

### How this squares with the earlier figures

- The user stories quote "329 MB PCM, ~576 MB RSS" for 300 s/48 kHz, and "165 MB PCM / 356 MB RSS" for 24 kHz. Those RSS figures are **settled or sampled** figures. engine.ts already warns that the true **peak** (VmHWM) on the production Opus path is ~762 MiB. This run gets a settled figure of ~490 MiB and a peak of ~720 MiB on synthetic Opus (pink noise plus a sine, 64 kb/s stereo). That is within the range engine.ts records, and below its 762, which is plausibly down to the content and the encoder settings. **For a phone, the peak is the number that matters**, because the peak comes during load, before a note plays.
- **JS heap is not where the memory is.** It stays under 1 MiB in every run. Decoded audio lives in AudioBuffer backing stores outside the V8 heap, so `performance.memory` and DevTools heap snapshots will both under-report it. On a real device, read process memory (Android: `chrome://inspect` → Memory, or `adb shell dumpsys meminfo <renderer pid>`; iOS: Xcode Instruments on Safari's WebContent process).

## Method

1. **Audio.** `ffmpeg` generates six stereo Ogg/Opus stems per length (300 s and 120 s) at 64 kb/s, which is close to production's ~2–2.5 MB per 300 s stem (the measured files were 13.4 MiB for six). Each stem has a different noise seed and tone. The audio goes to a temp dir and is deleted afterwards; none is committed (AGENTS.md §8).
2. **Engine.** `esbuild` bundles `apps/web/src/lib/play/engine.ts` **unchanged** into the harness page. The page fetches all six encoded stems first (as `load-stems.ts` does, so they are resident together) and then times `engine.load()`. Rate is the only variable, injected as `createAudioContext: () => new AudioContext({ sampleRate })`.
3. **Browser.** Playwright 1.63 drives Chrome for Testing 153 (headless) with `--disable-features=SpareRendererForSitePerProcess`, so there is exactly one renderer. The harness asserts that before every run. Each run is a fresh browser launch.
4. **Profiles.** The three profiles are desktop (1280×800), Playwright's `Pixel 7` descriptor, and Playwright's `iPhone 14` descriptor run on **Chromium**. That is a WebKit device's viewport, UA and touch settings, not WebKit.
5. **Memory.** The harness reads the renderer PID from CDP `SystemInfo.getProcessInfo`. It forces `gc()`, resets the high-water mark with `echo 5 > /proc/<pid>/clear_refs`, runs the load, and reads `VmHWM` (peak). It then waits 2 s with a `gc()` and reads `VmRSS` (settled). JS heap comes from CDP `Performance.getMetrics` (`JSHeapUsedSize`).
6. **Host.** Linux VM, 2 vCPU (Xeon @ 2.10 GHz), 8 GiB, no swap. Other agents were building and testing on it at the same time, so free memory was 3.1–5.0 GiB per run (recorded per row as `hostAvailMiB`). An earlier attempt with less free memory had a renderer **killed by the kernel OOM killer** mid-load. That says something about this box, not about phones, but it is a reminder that this load lives or dies on what the OS will give one tab.

To re-run: `node scripts/perf/mobile-player/measure.mjs --reps 3 --out results.json` (needs ffmpeg, Playwright, Linux `/proc`, and permission to write `clear_refs`).

## Caveats (what this does not license)

- **Emulation does not reproduce mobile memory limits, CPUs, codecs or tab-discard behaviour.** Every memory figure here is a desktop-Chromium figure. Do not read "Pixel 7 = 722 MiB" as a statement about a Pixel 7.
- **No real phone was measured. No WebKit was measured.** iOS Safari decodes Opus through a different path, and WebKit bugs 227636 and 189337 (see engine.ts) are about exactly this load. The "iPhone 14" row is Chromium wearing an iPhone's viewport.
- **Decode times are unreliable as absolutes.** The host was shared and loaded, and Chrome decodes off the main thread, so CDP CPU throttling would not have modelled a slower phone either (it was not used). A phone's decode time is unmeasured.
- **The audio is synthetic.** Real stems may decode to a different transient. engine.ts measured ~762 MiB peak on a real track's Opus stems.
- **`navigator.deviceMemory` reported 8 in every profile.** Emulation passes the host's value through, capped at 8. That is why the device rule in this PR does not rely on memory alone (see below).

## The shipped answer while 8.3 is open: a designed "not yet" state

[`apps/web/src/lib/play/device-support.ts`](../../apps/web/src/lib/play/device-support.ts) holds the rule. The first match wins:

1. `navigator.userAgentData.mobile === true` gives **mobile**. This covers Chrome on Android.
2. `(pointer: coarse)` matches and `(any-pointer: fine)` does not, which gives **touch-only**. This covers every phone, including Safari, and touch-only tablets. It does not catch touch laptops (their trackpad is a fine pointer) or iPads with a trackpad.
3. `navigator.deviceMemory` is reported and is under 4 GB, which gives **low-memory**.
4. Without `matchMedia`: touch is present and the screen's short side is under 600 px, which gives **touch-only**.

The rule deliberately ignores viewport width and the UA string. A narrow desktop window is still a desktop. Unknown signals never block.

In the emulations above, Pixel 7 and iPhone-on-Chromium both reported `uaDataMobile: true`, `coarse: true` and `anyFine: false`. Desktop reported `false / false / true`. So the rule blocks both phone profiles and passes desktop, and the unit tests pin this.

The check runs in `Player`'s effect **before** any engine, AudioContext or fetch exists, so a blocked device downloads no audio. An effect test (`test/play-player-effect.test.mjs`) asserts zero requests.

**To measure a real phone:** open a finished job with `?player=force` on the URL (for example `/jobs/<id>?player=force`). That skips the device rule only; the Web Audio check still applies. Then watch the renderer in `chrome://inspect` (Android) or Web Inspector (iOS). Record whether the load reaches the mixer, the peak memory, and whether the tab reloads. That is the measurement that would answer 8.3.

## 360px sweep (Story 8.1)

`scripts/design/mobile-sweep-360.mjs` opens each page at 360×740 (touch, `isMobile`, @2x). It compares `scrollWidth` with `clientWidth` and lists any element whose box extends past the viewport and is not clipped by an ancestor below `<body>`. That check matters because `body` has `overflow-x: hidden`, which would hide page-level overflow from a `scrollWidth` check alone. The job pages are driven by mocked `/api/jobs/:id` responses, one processing and one done, with a 90-character filename and a trim note. For `/account` and `/jobs/:id` (behind sign-in), the run patched their `getUser()` call **locally**, with nothing committed, and no session or token was used. `next dev`'s eval is blocked by the app's CSP, so the sweep context sets `bypassCSP`; production builds do not need this.

**Result: no page overflows at 360px, so no CSS fixes were needed.**

| Page | Overflow | Screenshot |
|---|---|---|
| Landing `/` | none | `landing-360.png` |
| Sign in `/login` | none | `sign-in-360.png` |
| Job history `/history`, empty and with 3 entries | none | `history-empty-360.png`, `history-entries-360.png` |
| Account `/account`, nav closed and open | none | `account-360.png`, `account-nav-open-360.png` |
| Job progress `/jobs/:id` (separating) | none | `job-progress-360.png` |
| Job done, player "not yet" state | none | `job-done-player-unsupported-360.png` |
| Pricing, terms, privacy, 404 | none | `pricing-360.png`, `terms-360.png`, `privacy-360.png`, `not-found-360.png` |

Screenshots are in [`docs/design/screens-2026-11-14/mobile/`](../design/screens-2026-11-14/mobile/), and the machine-readable result is `sweep-360.json`. PR 6 is changing the top nav in parallel, so re-run the sweep after it merges.

Seen in the sweep but out of this PR's scope, so not changed: the loops header still reads "Download all (ZIP)", which brand book §3.3 lists as a "don't". That copy is not mine to change here.
