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
- **Not PID-1/zombie-reaping either.** Tried `tini` as `ENTRYPOINT` two ways:
  plain (`/sbin/tini --`) and as a registered Linux subreaper (`/sbin/tini -s --`,
  needed because Fly's own Firecracker init is the *real* PID 1 — our command is
  always tini's child, never literal PID 1, so plain tini logged "Tini is not
  running as PID 1 and isn't registered as a child subreaper. Zombie processes
  will not be re-parented to Tini"). Deployed both variants
  (`fly deploy --remote-only --ha=false`, 2026-08-30 ~14:2x). **Identical
  failure either way** — same `Failed to connect to browser` exception at the
  same `nodriver/core/browser.py:343` call site, same crash loop, machine hit
  Fly's max-restart-count of 10 and was stopped. So PID-1/zombie-reaping is
  ruled out too; the `ENTRYPOINT ["/sbin/tini", "-s", "--"]` line is left in the
  Dockerfile as a harmless correctness improvement (proper signal forwarding is
  good practice regardless) but it is **not** the fix — do not re-try
  tini/dumb-init variants, that avenue is exhausted.

So it fails **only** when launched as the container's entrypoint under Fly's
init, while succeeding when run manually in that identical container, and it is
NOT a PID-1/subreaper issue. Remaining untried options: (a) get an actual
CDP-connection-refused root cause by adding verbose nodriver/CDP logging and
capturing chromium's own stderr (currently swallowed — we only see nodriver's
generic wrapper exception, never chromium's own startup output, so the real
underlying error is still unknown), or (b) give up on the Chromium-based
approach entirely and switch to a Node-based provider that needs no browser at
all (e.g. `bgutil-ytdlp-pot-provider`), which would need a small shim to expose
cobalt's `/token` shape. (b) is probably the higher-odds path given two
independent theories (sandbox flags, PID-1 handling) have now both failed to
explain the same symptom.

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
