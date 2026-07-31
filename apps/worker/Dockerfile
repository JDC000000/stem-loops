# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base

# System deps for librosa/soundfile/scipy
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer (cached separately from code)
FROM base AS deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Production image
FROM deps AS production
COPY . .

# NO HEALTHCHECK. This is a queue consumer, not a web service: CPU-bound loop
# extraction holds the CPython GIL and starves the co-located asyncio /health
# server, so any HTTP health probe times out mid-job and the platform kills a
# healthy-but-busy worker, orphaning the job. Already learned once at the Fly
# level (see fly.toml — no [http_service.checks]); a Dockerfile HEALTHCHECK
# reintroduces the identical failure mode on any Docker-based runtime.
# Liveness = restart-on-exit + the reaper. /health stays for manual probes.

EXPOSE 8000

CMD ["python", "-m", "src.worker.main"]
