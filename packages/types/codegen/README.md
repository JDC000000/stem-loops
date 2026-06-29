# Codegen

Types are generated from the Python worker's Pydantic models (single source of truth).

## Pipeline

```
apps/worker/src/worker/models.py (Pydantic)
  → scripts/codegen.py (worker side)
  → packages/types/schema/*.json (JSON Schema)
  → packages/types/scripts/codegen.mjs (TS side)
  → packages/types/src/generated.ts (TypeScript)
```

## Running

```bash
make codegen   # Full pipeline: Pydantic → JSON Schema → TypeScript
```

## Rules

- **Never** manually edit `packages/types/src/generated.ts`
- **Always** run `make codegen` after changing `apps/worker/src/worker/models.py`
- CI (`codegen-drift` job in `.github/workflows/ci.yml`) fails the build on drift

## Tool

`json-schema-to-typescript` — chosen over a hand-maintained OpenAPI spec because Pydantic-as-source
keeps one authoritative definition and avoids a second spec to sync. (TSD §7 decision.)
