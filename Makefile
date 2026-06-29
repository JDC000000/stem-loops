.PHONY: dev test-job types codegen migrate lint test clean

# Worker commands run with the src/ layout on PYTHONPATH so they work on a
# fresh checkout whether or not `pip install -e .` has been run.
WORKER_PY := PYTHONPATH=src .venv/bin/python

# Start the full local stack: web + worker + Postgres + MinIO (R2 emulator).
# Postgres + MinIO come up via docker compose; migrations run; then web + worker.
dev:
	docker compose -f docker-compose.dev.yml up -d postgres minio
	sleep 2
	$(MAKE) migrate
	pnpm --filter @stem-loops/web dev &
	cd apps/worker && $(WORKER_PY) -m worker.main

# Run a single job directly against the worker — no queue, verbose trace.
# Usage: make test-job URL=<youtube-url>
test-job:
	@test -n "$(URL)" || (echo "Usage: make test-job URL=<youtube_url>" && exit 1)
	cd apps/worker && $(WORKER_PY) -m worker.main --test-job "$(URL)"

# Regenerate the cross-language type contract: Pydantic -> JSON Schema -> TS.
# `types` is kept as an alias of `codegen` (tasks.md uses `types`, AGENTS.md uses `codegen`).
codegen:
	cd apps/worker && $(WORKER_PY) scripts/codegen.py
	cd packages/types && pnpm generate && pnpm build

types: codegen

# Run SQL migrations idempotently.
migrate:
	cd apps/worker && $(WORKER_PY) -m worker.migrate

# Lint both apps.
lint:
	cd apps/worker && .venv/bin/ruff check . && .venv/bin/black --check .
	pnpm --filter @stem-loops/web lint

# Run all tests.
test:
	cd apps/worker && .venv/bin/pytest
	pnpm --filter @stem-loops/web test

# Tear down the local stack and wipe volumes.
clean:
	docker compose -f docker-compose.dev.yml down -v
