# Self-hosted Cobalt — the PRIMARY YouTube audio-resolution path for the worker.
# Purpose: never touch YouTube from stem-loops' own (datacenter) server IP.
# Pinned to the v10 major tag; the v10 API is POST / (NOT /api/json — that was v7-v9).
FROM ghcr.io/imputnet/cobalt:10

# Cobalt reads PORT at boot; must match http_service.internal_port in fly.toml.
ENV PORT=9000
EXPOSE 9000
