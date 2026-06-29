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

## Developer recommendation (pre-measurement)
Lean **A — Cobalt primary, yt-dlp fallback**. Cobalt sidesteps cookies entirely (zero cookie-pool
maintenance, directly satisfies anti-goal #1) and the dual-path downloader (P2-8) keeps yt-dlp as a
resilient fallback. Confirm with the real bake-off before locking.

## Operator actions to open this gate
1. Provision Fly.io; `fly deploy --config cobalt/fly.toml`.
2. Provide `apps/worker/spikes/fixtures/fixture_urls.txt` (50 popular URLs).
3. Run `python harness.py ../fixtures/fixture_urls.txt` from a representative network.
4. Fill Results + Winner above.

## Gate 0 Status
[ ] APPROVED by operator
