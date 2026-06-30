.PHONY: dev test-job types test lint deploy-web deploy-worker migrate install help

# Default target
help:
	@echo "stem-loops make targets:"
	@echo "  make dev            - Spin up web + worker + Postgres + MinIO, run stub job end-to-end"
	@echo "  make test-job URL=  - Run worker on one URL with verbose logging (no queue)"
	@echo "  make types          - Run Pydantic → JSON Schema → TS codegen"
	@echo "  make test           - Run pytest + pnpm test"
	@echo "  make lint           - Run ruff + black check + eslint"
	@echo "  make deploy-web     - Deploy web to Vercel"
	@echo "  make deploy-worker  - Deploy worker to Fly.io"
	@echo "  make migrate        - Run database migrations"
	@echo "  make install        - pnpm install + pip install"

# Spin up full local stack and run a stub job end-to-end
dev:
	@echo "Starting stem-loops local dev stack..."
	docker compose up -d postgres minio minio-setup
	@echo "Waiting for services to be healthy..."
	@sleep 3
	@echo "Running migrations..."
	$(MAKE) migrate
	@echo "Starting worker and web..."
	docker compose up worker &
	cd apps/web && pnpm dev &
	@echo ""
	@echo "Stack is up:"
	@echo "  Web:      http://localhost:3000"
	@echo "  Worker:   http://localhost:8000"
	@echo "  MinIO:    http://localhost:9001 (minioadmin/minioadmin)"
	@echo "  Postgres: localhost:5432 (stemloops/stemloops)"
	@echo ""
	@echo "Submitting stub job..."
	@sleep 5
	curl -s -X POST http://localhost:3000/api/jobs \
		-H "Content-Type: application/json" \
		-d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","stems":["vocals","drums","bass","other"],"loop_length_bars":4}' \
		| python3 -m json.tool

# Run worker directly on one URL with verbose logging (no queue)
test-job:
	@if [ -z "$(URL)" ]; then echo "Usage: make test-job URL=https://..."; exit 1; fi
	cd apps/worker && \
		DATABASE_URL=$${DATABASE_URL:-postgresql://stemloops:stemloops@localhost:5432/stemloops} \
		R2_ACCESS_KEY_ID=$${R2_ACCESS_KEY_ID:-minioadmin} \
		R2_SECRET_ACCESS_KEY=$${R2_SECRET_ACCESS_KEY:-minioadmin} \
		R2_ENDPOINT=$${R2_ENDPOINT:-http://localhost:9000} \
		R2_BUCKET_NAME=$${R2_BUCKET_NAME:-stem-loops-dev} \
		STUB_MODE=$${STUB_MODE:-true} \
		LOG_LEVEL=DEBUG \
		python -m src.worker.cli test-job "$(URL)"

# Run Pydantic → JSON Schema → TS codegen
types:
	cd packages/types && python scripts/codegen.py
	@echo "Checking for drift..."
	@git diff --exit-code packages/types/src/ || (echo "TYPE DRIFT DETECTED: run 'make types' and commit the result" && exit 1)
	@echo "Types are in sync."

types-generate:
	cd packages/types && python scripts/codegen.py
	@echo "Types generated."

# Run all tests
test:
	cd apps/worker && python -m pytest tests/ -v
	pnpm --filter web test || true

# Run linters
lint:
	cd apps/worker && python -m ruff check src/ tests/
	cd apps/worker && python -m black --check src/ tests/
	pnpm --filter web lint || true

# Deploy web to Vercel
deploy-web:
	cd apps/web && npx vercel deploy --prod

# Deploy worker to Fly.io
deploy-worker:
	cd apps/worker && fly deploy

# Run database migrations
migrate:
	cd apps/worker && \
		DATABASE_URL=$${DATABASE_URL:-postgresql://stemloops:stemloops@localhost:5432/stemloops} \
		python -m src.worker.migrate

# Install all dependencies
install:
	pnpm install
	cd apps/worker && pip install -r requirements.txt
