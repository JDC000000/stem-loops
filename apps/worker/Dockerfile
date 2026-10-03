# syntax=docker/dockerfile:1
# Pinned to the exact base of the prod worker image (Fly v18, 2026-08-30):
# python:3.11.16-slim as published 2026-08-25 (repo-info da9e234). Its amd64 layer
# diff_ids match the prod image's first four layers.
FROM python:3.11.16-slim@sha256:1042b61448fef4ba92d16a8c7eb4996d027568ce64792a7877fd88511e0af7c6 AS base

# System deps for librosa/soundfile/scipy
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer (cached separately from code)
FROM base AS deps
# constraints-prod.txt pins every package to the version prod runs (floors alone re-resolve).
COPY requirements.txt constraints-prod.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints-prod.txt

# Production image
FROM deps AS production
COPY . .

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

EXPOSE 8000

CMD ["python", "-m", "src.worker.main"]
