FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for librosa/soundfile
RUN apt-get update && apt-get install -y \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["python", "-m", "worker.main"]
