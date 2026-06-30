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

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

EXPOSE 8000

CMD ["python", "-m", "src.worker.main"]
