# stem-loops-cobalt — self-hosted Cobalt relay (production support service)

Stage 1 of the worker's download pipeline (`apps/worker/src/worker/downloader/`):
**Cobalt (primary) → yt-dlp (fallback)**. Cobalt resolves YouTube audio from
Fly's network so we never touch YouTube from stem-loops' own datacenter IP —
that IP is near-100% bot-blocked without a residential proxy, which is why every
job was failing `DOWNLOAD_BLOCKED` while no Cobalt instance existed.

- **App:** `stem-loops-cobalt` (Fly.io org `personal`, region `iad`)
- **URL:** https://stem-loops-cobalt.fly.dev/
- **Image:** `ghcr.io/imputnet/cobalt:10` (running 10.9.4)

The app name is load-bearing: it is the hardcoded `COBALT_URL` default in
`cobalt_client.py`, so the worker picks it up with **no env var change**.

## Deploy

```bash
cd apps/worker/cobalt
fly deploy --remote-only --ha=false
```

## Verify

```bash
# 1. instance alive (returns version + service list)
curl -s https://stem-loops-cobalt.fly.dev/ | jq

# 2. resolve real YouTube audio (v10 API: POST /, NOT /api/json)
curl -s -X POST https://stem-loops-cobalt.fly.dev/ \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","downloadMode":"audio","audioFormat":"wav"}'
# -> {"status":"tunnel","url":"https://stem-loops-cobalt.fly.dev/tunnel?...","filename":"..._audio.wav"}

# 3. the tunnel URL must actually stream bytes (a 0-byte 200 is a FAILURE, see below)
curl -sL "<tunnel url>" -o /tmp/t.wav -w '%{size_download}\n'
```

## Gotchas

- **API version.** v10 serves `POST /`. `POST /api/json` (the v7-v9 endpoint)
  returns `404 Cannot POST /api/json`. The client was fixed to match.
- **`API_URL` is mandatory.** Cobalt v10 refuses to serve unless `API_URL` equals
  the instance's own public URL. It is set in `fly.toml`, not as a secret.
- **Scale-to-zero cold start.** `min_machines_running = 0` means the first call
  after idle costs ~7s of boot. `COBALT_TIMEOUT` in the client defaults to 30s to
  clear that; don't lower it back to 10s or cold starts will fall through to yt-dlp.
- **Empty tunnel on some videos.** A minority of videos resolve to `status:"tunnel"`
  but the tunnel then streams `content-length: 0` (observed on
  `youtube.com/watch?v=xlo8CDp3KnU`, reproducible across formats and retries, while
  `dQw4w9WgXcQ`/`jNQXAC9IVRw` return full audio). Cobalt reports success, so the
  caller gets a URL that yields an empty file rather than a typed error and no
  yt-dlp fallback fires. Not yet handled — track separately.
