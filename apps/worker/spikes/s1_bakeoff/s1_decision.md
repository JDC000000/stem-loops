# S1 Decision Record — YouTube Download Path

## What was built (D-tasks complete)
- `cobalt/Dockerfile`, `cobalt/fly.toml` — self-hosted Cobalt deploy spec (Fly.io, lax, scale-to-zero)
- `cobalt_client.py` — Cobalt HTTP client; returns `{success, url, latency_ms, error}`, never raises
- `ytdlp_client.py` — yt-dlp client with server-side cookie rotation + secret redaction
- `harness.py` — 50-URL concurrent bake-off with success-rate + p90 latency reporting

## Smoke-test results (dev sandbox)
| Client | Call | Result |
|---|---|---|
| `ytdlp_client` | `watch?v=dQw4w9WgXcQ` | clean dict, `success=false`, error redacted; reached postprocessing then failed on **missing ffmpeg** (no bot-block on this attempt) |
| `cobalt_client` | `watch?v=dQw4w9WgXcQ` | clean dict, `success=false`, error `Name or service not known` (spike instance **not deployed**) |

Both clients behave correctly: measured dict out, no exceptions, cookie/token patterns redacted (PRD §6.1 / §8 #1).

## Full 50-URL bake-off — BLOCKED (needs operator infra)
The headline metric (≥95% success, p90 <10s) **cannot be measured from this sandbox**:
1. **Cobalt not deployed** — no `fly` CLI / Fly.io account/token in this environment.
2. **ffmpeg missing** — no sudo/apt; yt-dlp `-x --audio-format wav` can't transcode.
3. **No `fixture_urls.txt`** — the 50-URL sample is operator-provided.
4. **Datacenter IP** — sandbox egress is a datacenter IP; YouTube bot-challenges these, so any
   success rate measured here would understate the real (residential/Cobalt) rate. This is the exact
   V1 failure mode the spike exists to neutralise.

## Results (to be filled when bake-off runs on real infra)
| Path    | Success/50 | p90 latency |
|---------|-----------|-------------|
| Cobalt  | TBD       | TBD ms      |
| yt-dlp  | TBD       | TBD ms      |

## Winner
[ ] A: Cobalt (primary) + yt-dlp (fallback)
[ ] B: yt-dlp (primary) + Cobalt (fallback)

## Gate 0 ruling (operator, 2026-06-29)
**ARCHITECTURE approved: Cobalt primary + yt-dlp fallback** (PRD §7 locked decision). Building the
client code in Phase 1 is approved. This unblocks Phase 1 (which uses a STUB downloader — no real
YouTube call).

**NOT approved / NOT done:** the download path is **NOT validated as production-ready.** The
≥95%-success bake-off (PRD §7 open-question #1) was never measured — the sandbox IP was bot-challenged
and the Cobalt instance was never deployed. Treating S1 as "validated" is explicitly out of bounds.

## ⛔ PRE-T12 PRODUCTION GATE (REQUIRED, still OPEN)
The real bake-off **MUST run and pass before T12** (Phase 2 real YouTube download integration):
- **Bar:** ≥95% success across 50 popular YouTube URLs, p90 <10s, for the chosen primary path.
- **Where:** Cobalt deployed on Fly.io (Fly IPs ARE the production scenario — no home IP needed for
  the Cobalt half); yt-dlp fallback needs a non-datacenter IP or cookie rotation.

### Operator infra needed to run it (flag with lead time before T12)
1. **Fly.io account + CLI access** — to deploy the Cobalt instance (`fly deploy --config cobalt/fly.toml`).
2. **ffmpeg** available in the execution environment (yt-dlp `-x --audio-format wav` needs it).
3. **`apps/worker/spikes/fixtures/fixture_urls.txt`** — 50 popular YouTube URLs for `harness.py`.
4. Run `python harness.py ../fixtures/fixture_urls.txt`, fill Results + Winner above.

## Developer recommendation (pre-measurement, to confirm via the bake-off)
Lean **A — Cobalt primary, yt-dlp fallback**. Cobalt sidesteps cookies entirely (zero cookie-pool
maintenance, directly satisfies anti-goal #1) and the dual-path downloader (P2-8) keeps yt-dlp as a
resilient fallback. **Do not lock until the ≥95% bake-off passes.**

## Status
- Architecture (primary/fallback choice): **APPROVED at Gate 0**
- ≥95% production bake-off: **[ ] NOT RUN — hard gate before T12**
