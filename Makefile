.PHONY: dev test-job types types-generate alphabet alphabet-generate testlint check-rls check-prices deploy-web deploy-worker migrate install help

# Default target
help:
	@echo "stem-loops make targets:"
	@echo "  make dev            - Spin up web + worker + Postgres + MinIO, run stub job end-to-end"
	@echo "  make test-job URL=  - Run worker on one URL with verbose logging (no queue)"
	@echo "  make types          - Run Pydantic → JSON Schema → TS codegen"
	@echo "  make alphabet-generate - Regenerate web chord alphabet.ts from alphabet.py"
	@echo "  make alphabet       - alphabet-generate + drift check"
	@echo "  make test           - Run pytest + pnpm test"
	@echo "  make lint           - Run ruff + black check + eslint"
	@echo "  make check-rls      - Assert every migration table has RLS + a policy (SL-B26)"
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

# Chord alphabet: apps/training/model/alphabet.py -> apps/web/src/chord/alphabet.ts
ALPHABET_GENERATED = apps/web/src/chord/alphabet.ts apps/web/src/chord/__tests__/fixtures/alphabet-parity.json

alphabet-generate:
	python3 packages/types/scripts/codegen_alphabet.py
	@echo "Alphabet generated."

alphabet: alphabet-generate
	@echo "Checking for drift..."
	@git diff --exit-code $(ALPHABET_GENERATED) || (echo "ALPHABET DRIFT DETECTED: run 'make alphabet-generate' and commit the result" && exit 1)
	@echo "Alphabet is in sync."

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
	cd apps/worker && pip install -r requirements.txt -c constraints-prod.txt

# Assert every table in migrations/*.sql has RLS + a CREATE POLICY (SL-B26 #1).
check-rls:
	python3 scripts/check_rls.py apps/worker/migrations/

# Audit M5: credit_packs price vs Stripe unit_amount. Needs STRIPE_SECRET_KEY +
# STRIPE_PRICE_CREDITS_{20,60,180}; SOURCE=db DATABASE_URL=... checks a live DB.
# Also usable as a manual pre-deploy checklist item.
check-prices:
	python3 scripts/check_credit_pack_prices.py --source $${SOURCE:-migration}
