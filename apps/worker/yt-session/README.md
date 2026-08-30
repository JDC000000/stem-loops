# stem-loops-yt-session — YouTube poToken generator

Intended to supply Cobalt with a Proof-of-Origin Token via
`YOUTUBE_SESSION_SERVER`, which is the documented fix for the 403/empty-tunnel
problem described in `apps/worker/cobalt/README.md`.

Cobalt's `processing/helpers/youtube-session.js` expects `GET /token` returning
`{potoken, visitor_data, updated}` — the `ghcr.io/imputnet/yt-session-generator:webserver`
contract.

## ⚠️ STATUS: deployed but NOT working — scaled to 0

The app exists (Fly org `personal`, region `iad`) but is **scaled to 0 machines**
so it does not bill, because it crash-loops on Fly:

```
[INFO] starting Xvfb
[INFO] launching chromium instance
Exception: Failed to connect to browser
  ... nodriver/core/browser.py line 343
Main child exited normally with code: 1
```

`YOUTUBE_SESSION_SERVER` is deliberately **not** set on `stem-loops-cobalt` — a
session server that never mints a token would make cobalt fail *closed* on every
video (`error.api.youtube.no_session_tokens`), i.e. 2/12 → 0/12.

### What was ruled out (all verified inside the Fly VM)

- **Chromium itself works.** `chromium --no-sandbox --disable-dev-shm-usage`
  starts and DevTools listens. The dbus/GPU log lines are noise.
- **Not the sandbox.** `nodriver.start(..., sandbox=False)` succeeds interactively.
- **Not `/dev/shm`.** It is 984MB, not the usual 64MB.
- **Not an Xvfb race.** Upstream's `sleep 2` and a poll-until-`xdpyinfo`-ready both
  succeed.
- **Not `HOME`.** Works with `HOME=/root` and with `HOME` unset.
- **Not memory.** Raised to 2GB; same failure.
- **The unmodified upstream call succeeds** when run by hand in the same image on
  the same VM.

So it fails **only** when launched as the container's entrypoint under Fly's init,
while succeeding when run manually in that identical container. Prime remaining
suspect is PID-1/process-group behaviour (Chromium subprocess reaping under Fly
init) — try `tini`/`dumb-init`, or a Node-based provider that needs no browser at
all (e.g. `bgutil-ytdlp-pot-provider`, which would need a small shim to expose
cobalt's `/token` shape).

The `sandbox=False` + `--no-sandbox --disable-dev-shm-usage` patch in the
Dockerfile is retained: harmless, and required for any root-run Chromium.

## Deploy (once fixed)

```bash
cd apps/worker/yt-session
fly scale count 1 -a stem-loops-yt-session && fly deploy --remote-only --ha=false
curl -s https://stem-loops-yt-session.fly.dev/token | jq   # expect potoken + visitor_data
# only then, on the cobalt app:
fly secrets set YOUTUBE_SESSION_SERVER=https://stem-loops-yt-session.fly.dev/ -a stem-loops-cobalt
```
