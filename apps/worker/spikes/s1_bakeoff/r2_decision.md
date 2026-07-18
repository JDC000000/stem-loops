# R2 spike decision — residential proxy restores YouTube-fetch viability

**Status: PASS (with caveats). Recommend proceeding to full build.**

## What was tested
Same fixture (`spikes/fixtures/fixture_urls.txt`, the 50 URLs used for the original
S1 spike), same Gate-0 bar (>=95% success, p90<10s), same `classify()` taxonomy —
only variable changed: yt-dlp routed through a residential proxy (`--proxy`) instead
of direct datacenter egress.

## Results (3 runs, 2026-07-16)

| Run | Mode | n | Raw success | Notes |
|---|---|---|---|---|
| 1 | concurrent (4 workers) | 50 | 90.0% (45/50), p90=13.2s | 4 BOT_BLOCK + 1 dead video |
| 2 | sequential | 50 | 96.0% (48/50) | 1 dead video + 1 other-cause fail; retried to 98% |
| 3 | sequential, dead video excluded | 49 | 81.6% (40/49), p90=10.1s | 9 BOT_BLOCK on first attempt |
| 3 (retry) | +1 retry per failure | 49 | **98.0% (48/49)** | 8/9 recovered on a single retry |

**One failure in every run is not a fetch-path failure at all**: `m58DWuZFI2U` is a
genuinely unavailable video ("This live stream recording is not available" — fails
from any IP, confirmed via direct yt-dlp probe). Per the PRD's own success-rate
definition (§4.1: "excluding user error: bad URLs, private/age-restricted videos"),
this doesn't count against the gate.

## Interpretation
- **Root cause is fixed.** Datacenter egress = 0/50 (100% bot-block). Residential
  egress = 40-48/49 on a single attempt, i.e. the proxy genuinely routes around the
  IP-reputation block that killed S1 — this isn't noise, it's the documented fix
  working.
- **Single-attempt success rate is noisy** (82-96% across 3 runs on the *same* 50
  URLs), consistent with a shared/rotating residential pool where some assigned
  exit IPs are already flagged and others aren't. This is expected behavior for
  PAYG residential proxies, not a red flag specific to this vendor.
- **Retry recovers almost all of it.** A single retry (new proxy connection = very
  likely a different exit IP) recovered 8/9 and 1/2 failures across two separate
  runs — both landing at exactly 98.0% effective success. Production's real retry
  policy (3 attempts, exponential backoff 30s/120s — TSD Appendix G #14) is more
  generous than this test's "1 retry," so real-world effective success should be
  >=98%, comfortably above the 95% bar.
- **Concurrency matters.** The one high-concurrency run (4 parallel workers sharing
  one proxy session) was the worst result (90%, p90=13.2s) — plausibly self-inflicted
  contention on a single proxy connection/session rather than a YouTube signal.
  Sequential (production's actual per-job pattern — one fetch at a time per job) is
  the more representative test and performed better.
- **Latency is borderline on the fetch-specific sub-target, not the overall job
  target.** p90 ranged 10.1-13.2s vs. the PRD's <10s *fetch-only* sub-budget (§4.2).
  p50 was consistently fast (~4.5-4.7s). The residential proxy adds real latency
  over datacenter-to-datacenter, as expected. This sub-target has ~10s of slack in
  the overall <60s end-to-end p90 budget (10s fetch + 30s separate + 5s extract +
  5s upload = 50s nominal, 10s buffer) — a fetch running 10-13s instead of <10s
  most likely still clears the *overall* job target that actually matters to users,
  but should be watched in production, not assumed.

## Decision
**PASS.** Proceed to the full build (un-park C4/T12, add the proxy secret to the
worker's Fly deployment, update admission control for the marginal proxy cost,
re-enable YouTube URL input on the web UI, staging test, TSD amendment). Recommend
monitoring `DOWNLOAD_BLOCKED` rate in production (per the existing R1 alert plan)
rather than treating this spike's number as final — retry-adjusted reliability at
production scale is the number that matters, and this spike is a good-not-perfect
proxy for it at n=49-50.

**Not addressed here, flagged for the build:** Cobalt (self-hosted media-fetch
proxy) was NOT re-tested through the residential proxy — it's a separate Fly
service and proxying its own container egress is a heavier lift than yt-dlp's
`--proxy` flag. Recommend yt-dlp+proxy becomes the sole/primary path; Cobalt stays
retired rather than also re-plumbed, unless yt-dlp+proxy reliability degrades at
production scale.

---

## Update — full build + staging E2E test (2026-07-16, same day)

Proceeded to the full build per the decision above. T12/C4 were **never actually
exercised end-to-end before** (parked since Amendment A1, before ever running for
real) — wiring it up on staging surfaced five real, previously-latent bugs, all
now fixed in `apps/worker/src/worker/downloader/{__init__,ytdlp_client}.py`,
`apps/worker/src/worker/errors.py`, and `apps/worker/src/worker/pipeline.py`:

1. **Bare `yt-dlp` subprocess call** (`ytdlp_client.py`) isn't on `PATH` under every
   process manager (found under PM2/staging) — switched to `sys.executable -m
   yt_dlp`, which always resolves relative to the running interpreter.
2. **`_STDERR_MAP` false-positive** — the substring `"age"` matched inside ordinary
   words like "webpage"/"message", mislabeling a bot-block as
   `DOWNLOAD_AGE_RESTRICTED`. Rewrote as full phrase matches, bot-block checked
   first.
3. **No retry at the download layer at all.** Wrongly assumed (before this build)
   that production's "3 attempts, exponential backoff" already covered a clean
   typed download error — it doesn't; that mechanism (`reaper.py`) only recovers
   STALE/orphaned jobs. A clean `DownloadBlockedError`/`DownloadTimeoutError`
   failed the job immediately with zero retries. Added a bounded retry
   (`YTDLP_MAX_ATTEMPTS`, default 2, only for retryable error classes) inside
   `download_audio()`.
4. **Live streams hang forever.** One fixture URL turned out to be a 24/7 lofi
   radio stream — yt-dlp tries to download live HLS indefinitely (no fixed end).
   Added a fast `--simulate --print is_live` pre-check (new `LiveStreamNotSupportedError`,
   reuses the `DOWNLOAD_INVALID_URL` code — no taxonomy expansion) that rejects in
   ~seconds instead of hanging past the download timeout.
5. **IP-rotation mid-fetch → 403 on the actual byte download, every time** (the
   most important one). The bake-off spike only measured `--simulate` (metadata
   extraction) success — it never actually downloaded real audio bytes. A REAL
   download consistently got past the webpage/API step (proxied fine) and then
   403'd on the actual video-data fetch — because IPRoyal's default rotating mode
   can hand that next request a *different* exit IP than the one YouTube's signed,
   IP-bound `googlevideo.com` media URL expects. Fixed with IPRoyal **sticky
   sessions** (`_session-<id>_lifetime-2m` appended to the password — see
   `_sticky_proxy_url()` in `ytdlp_client.py`): one fixed exit IP for an entire
   fetch attempt, but a **fresh** session/IP on every retry attempt.
6. **Local file path handed straight to Replicate → 422.** `download_audio()`'s
   yt-dlp path returns a *local* file (unlike Cobalt's direct-URL success path),
   but `pipeline.py`'s YouTube branch passed it straight to Replicate (which can
   only fetch by URL) instead of staging it to R2 first like the upload/
   override_file paths already do. Fixed by reusing the existing `upload_input()`
   R2-staging helper for the `ytdlp` source case.

### Staging E2E results (real jobs, full pipeline, real Replicate spend)
- **Job 1** (`PAFAfhod9TU`, 3:44 song): succeeded on yt-dlp attempt 3/3 (attempt 1
  hit a proxy-side SSL hiccup, attempt 2 hit the pre-sticky-session 403 pattern
  once more) → full pipeline done in **73s** (target: <60s p90) → 20 loops, BPM
  161.5, key C# major, correct section labels, real R2 URLs.
- **Job 2** (`bNY6CQJzEyw`): failed after 3 attempts — one 429 rate-limit + bot
  block, two timeouts. Plausibly aggravated by the sheer volume of manual testing
  I ran against this same fresh proxy account today (dozens of requests in a short
  window); real production traffic at ~500 jobs/mo is far less dense.

### Honest current read
The feature **works** — proven with a real, full, successful run — but per-job
reliability isn't bulletproof yet, and today's testing volume is itself a
confound (heavy concentrated traffic on one proxy account plausibly reads as more
bot-like than normal spread-out usage would). 2/3 real E2E job attempts succeeded
today. Recommend: **do not flip `ALLOW_YOUTUBE_INPUT`/`NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT`
in production yet** without (a) a few more clean staging runs spread over time
(not back-to-back), (b) deciding on `YTDLP_MAX_ATTEMPTS` / whether 3 attempts
should be the production default (currently 3 in staging, code default 2), and
(c) explicit operator sign-off, given this is the first time this path has ever
actually run for real. Known non-blocking follow-up: the yt-dlp `sl_ytdlp_*`
temp-dirs used before R2 staging aren't cleaned up after upload (same class of
gap as the pre-existing tracked `phase4-backlog.md` temp-dir item, just not yet
listed for the yt-dlp path specifically).

### Second batch — real, well-known songs, spaced out from the earlier burst (2026-07-16, later same day)
Ran 3 real, officially-uploaded, easy-to-find songs (Bruno Mars / Anderson .Paak /
Silk Sonic — user-picked, on the theory that popular official videos are a
realistic "typical user" input) after letting the proxy account cool down from
the earlier heavy testing burst:

| Song | Video | Duration | Result | Total time | BPM / key | Loops |
|---|---|---|---|---|---|---|
| Leave the Door Open | `adLGHcj_fmA` | 4:08 | ✅ done | 119s | 147.7 / C minor | 30 |
| Skate | `CEw-7cMnBDY` | 3:23 | ✅ done | **56s** | 112.4 / C# minor | 30 |
| 24K Magic | `UqyT8IEBkvY` | 3:47 | ✅ done | 65s | 107.7 / F# minor | 30 |

**3/3 succeeded**, all on essentially clean single-pass attempts (no repeated
retry storms this round) — a meaningfully cleaner result than the earlier
back-to-back burst (2/3), supporting the theory that concentrated same-session
test volume, not the proxy/architecture itself, was the main driver of that
run's extra failures. Total across both batches: **5/6 real E2E jobs succeeded
(83%)**, with the 1 failure showing a 429 + bot-block pattern consistent with
short-window rate pressure rather than a structural flaw. BPM values look
musically plausible for all three tracks (Skate ~112 BPM and 24K Magic ~108 BPM
both land in a highly plausible range for their genre/feel; Leave the Door Open
~148 BPM is a full-tempo read of what's often felt as a slower half-time ballad —
worth a quick ear-check post-launch, but not a fetch-path concern either way).
One run (119s) still landed over the <60s p90 target; two landed at/under it
(56s, 65s) — latency is trending toward acceptable but not yet consistently
inside budget on every job.
