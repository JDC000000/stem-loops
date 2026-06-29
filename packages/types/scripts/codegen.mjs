// Compile the combined Pydantic JSON Schema → src/generated.ts.
// Source of truth is apps/worker (Pydantic). Run via `make codegen` / `pnpm generate`.
import { compile } from 'json-schema-to-typescript';
import { readFileSync, writeFileSync } from 'fs';

const SCHEMA_FILE = './schema/contract.schema.json';
const OUT_FILE = './src/generated.ts';

const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));

const ts = await compile(schema, 'StemLoopsContract', {
  bannerComment: '/* AUTO-GENERATED from apps/worker Pydantic models — DO NOT EDIT. Run: make codegen */',
  additionalProperties: false,
  declareExternallyReferenced: true,
  style: { singleQuote: true },
});

writeFileSync(OUT_FILE, ts);
console.log(`Generated ${OUT_FILE}`);
