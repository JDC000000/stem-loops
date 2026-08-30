# stem-loops-cobalt — self-hosted Cobalt relay

Stage 1 of the worker's download pipeline (`apps/worker/src/worker/downloader/`):
**Cobalt (primary) → yt-dlp (fallback)**.

- **App:** `stem-loops-cobalt` (Fly.io org `personal`, region `iad`)
- **URL:** https://stem-loops-cobalt.fly.dev/ · **Image:** `ghcr.io/imputnet/cobalt:10` (10.9.4)

The app name is load-bearing: it is the hardcoded `COBALT_URL` default in
`cobalt_client.py`, so the worker picks it up with **no env var change**.

## ⚠️ STATUS: NOT a working fix for YouTube ingestion (as of 2026-08-30)

Cobalt is deployed and healthy, but it only resolves **2 of 12** tested popular
videos. Do not treat this as launched.

```
dQw4w9WgXcQ 37,589,168 B OK   |  9bZkp7q19f0 0 B   kJQP7kiw5Fk 0 B   fJ9rUzIMcZQ 0 B
jNQXAC9IVRw  3,362,930 B OK   |  xlo8CDp3KnU 0 B   3JZ_D3ELwOQ 0 B   OPf0YbXqDm0 0 B
                              |  6Mgqbai3fKo 0 B   y6120QOlsfU 0 B   L_jWHffIx5E 0 B
                              |  e-ORhEE9VVg 0 B
```

### Root cause (measured, not inferred)

1. Cobalt resolves metadata fine and returns `status:"tunnel"` with a signed URL.
2. Its `stream/internal.js` then HEADs the upstream googlevideo URL. That HEAD
   returns **403** for most videos. On a non-200 (or missing content-length) it
   calls `cleanup()` → `res.end()`, so *our* request completes as
   **`200 OK, content-length: 0`** with no error — a silent failure.
3. The 403 is **YouTube's SABR / proof-of-origin (poToken) enforcement**, not IP
   reputation. Proven by A/B: resolving and fetching through an iproyal
   **residential** exit produced byte-for-byte identical results to the Fly
   datacenter IP — same 2 successes, same 10 × 403.

   ```
   A_direct     dQw4w9WgXcQ:200/1300631  jNQXAC9IVRw:200/117526  kJQP7kiw5Fk:403  9bZkp7q19f0:403 ...
   B_via_proxy  dQw4w9WgXcQ:200/1300631  jNQXAC9IVRw:200/117526  kJQP7kiw5Fk:403  9bZkp7q19f0:403 ...
   ```

   So `API_EXTERNAL_PROXY` does **not** help and was removed — routing Cobalt
   through a paid per-GB residential proxy would have added cost for zero benefit.
4. Alternative innertube clients are worse, not better. With
   `CUSTOM_INNERTUBE_CLIENT`: `TV_EMBEDDED` and `WEB_EMBEDDED` →
   `error.api.content.video.unavailable` on *all* videos (they *require* a
   poToken); `ANDROID` → `error.api.fetch.fail` on all. Default `IOS` is the best
   available and is what we run.

### What the client now does about it

`cobalt_client.py` reads a few bytes off the tunnel before returning success
(`COBALT_VERIFY_BYTES`, default 8192). An empty tunnel becomes a
`DownloadBlockedError` instead of a URL that yields a silent empty file — so the
yt-dlp fallback actually fires and the failure is honest. Verified the probe does
not consume the tunnel (full GET after an 8KB probe still returned all 37,589,168
bytes) and does discriminate (8192 vs 0 bytes).

### The real fix, still outstanding

Point `YOUTUBE_SESSION_SERVER` at a poToken generator — see
`apps/worker/yt-session/` (deployed but **not yet working**; details in its README).

## Deploy / verify

```bash
cd apps/worker/cobalt && fly deploy --remote-only --ha=false

curl -s https://stem-loops-cobalt.fly.dev/ | jq          # instance alive
# v10 API is POST / — NOT /api/json (that 404s; it was the v7-v9 endpoint)
curl -s -X POST https://stem-loops-cobalt.fly.dev/ \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","downloadMode":"audio","audioFormat":"wav"}'
# then confirm the tunnel STREAMS BYTES — a 0-byte 200 is a failure, not a success:
curl -sL "<tunnel url>" -o /tmp/t.wav -w '%{size_download}\n'
```

## Gotchas

- **`API_URL` is mandatory** — v10 refuses to serve unless it equals the instance's
  own public URL. Set in `fly.toml`, not as a secret.
- **Scale-to-zero cold start** ~7s. `COBALT_TIMEOUT` defaults to 30s to clear it;
  don't drop it back to 10s or cold starts fall through to yt-dlp.
