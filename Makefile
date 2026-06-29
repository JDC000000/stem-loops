.PHONY: dev test-job migrate codegen lint

dev:
	docker-compose -f docker-compose.dev.yml up

test-job:
	@echo 'Usage: make test-job URL=<youtube-url>'
	cd apps/worker && python -m worker.main --test-job '$(URL)'

migrate:
	cd apps/worker && python -m worker.migrations.run

codegen:
	cd apps/worker && python scripts/codegen.py
	cd packages/types && pnpm build

lint:
	cd apps/web && pnpm lint && pnpm tsc --noEmit
	cd apps/worker && ruff check . && black --check .
