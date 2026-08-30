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

EXPOSE 8080
