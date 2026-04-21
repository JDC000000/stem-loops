FROM python:3.11-slim

# System deps: ffmpeg for audio, libsndfile for soundfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps (the big ones first for better caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Demucs model so cold start is instant
RUN python -c "import demucs.pretrained; demucs.pretrained.get_model('htdemucs_6s')"

COPY pipeline.py worker.py ./

CMD ["python", "-u", "worker.py"]
