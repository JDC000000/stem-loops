# PoToken / visitor_data generator for the Cobalt relay.
# Runs Chromium under Xvfb to execute Google's BotGuard attestation and serves the
# result at GET /token as {potoken, visitor_data, updated} — the exact contract
# cobalt's src/processing/helpers/youtube-session.js expects.
FROM ghcr.io/imputnet/yt-session-generator:webserver

# Upstream calls nodriver.start(headless=False, ...) with no sandbox/arg config,
# which cannot start Chromium in this environment (Fly runs containers as root
# under Firecracker with a small /dev/shm) — the browser never comes up and the
# process crash-loops on "Failed to connect to browser".
#   --no-sandbox / sandbox=False : Chromium's setuid+userns sandbox can't init as root.
#   --disable-dev-shm-usage      : container /dev/shm is 64MB; Chromium's shared
#                                  memory allocs exceed it and the renderer dies.
#   --disable-gpu / rasterizer   : no GPU in the VM; avoids a slow failing probe.
# Safe here: the container only loads youtube.com to mint an anonymous attestation
# token. It never handles our data, our users' data, or untrusted input.
# The patch is asserted so a silent upstream refactor fails the BUILD rather than
# shipping another crash-looping image.
RUN sed -i 's/nodriver\.start(headless=False,/nodriver.start(headless=False, sandbox=False, browser_args=["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-software-rasterizer"],/' \
      /app/potoken_generator/extractor.py \
 && grep -q 'disable-dev-shm-usage' /app/potoken_generator/extractor.py \
 || (echo "PATCH FAILED: nodriver.start() call site changed upstream" && exit 1)

# The upstream image ships NO Dockerfile ENTRYPOINT: its CMD
# (["./startup-webserver.sh"]) runs directly as PID 1. That shell script
# backgrounds Xvfb, then runs the Python webserver as a foreground child —
# so PID 1 is a bare `/bin/sh` with no SIGCHLD/zombie-reaping or signal-
# forwarding behavior. Chromium forks several of its own subprocesses
# (zygote, GPU process, renderer) during startup; under Fly's Firecracker
# init, those get launched as real PID-1-parented processes (unlike an
# interactive `fly ssh console` shell, where the console shell + its job
# control is the parent instead). Confirmed by direct A/B on the same
# image/VM: the unmodified startup command succeeds when run BY HAND in an
# interactive shell, and fails ("Failed to connect to browser") only when
# Fly launches it as the real container entrypoint. tini as PID 1 gives
# proper subreaper/zombie-reaping and signal forwarding, which is exactly
# what's missing here.
RUN apk add --no-cache tini

# Fly's own Firecracker-VM init is itself PID 1 (Fly does not put the container
# command in its own PID namespace the way `docker run` does) — our command
# always launches as a CHILD of Fly's init, never as literal PID 1. Confirmed
# by the deploy log: "Tini is not running as PID 1 and isn't registered as a
# child subreaper. Zombie processes will not be re-parented to Tini, so zombie
# reaping won't work." -s registers tini as a Linux subreaper (prctl
# PR_SET_CHILD_SUBREAPER) so it still catches reparented grandchildren
# (Chromium's zygote/GPU/renderer subprocesses) even without being real PID 1.
ENTRYPOINT ["/sbin/tini", "-s", "--"]
CMD ["./startup-webserver.sh"]

EXPOSE 8080
