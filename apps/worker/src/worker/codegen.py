"""Generate ONE combined JSON Schema from the canonical Pydantic models.

Pydantic is the single source of truth. We emit a single schema document with all
models under `$defs` (via `models_json_schema`, which de-duplicates shared nested
models like JobEvent/Loop) plus a wrapper root that references each, so the TS
side (`packages/types/scripts/codegen.mjs`) compiles every type exactly once with
no duplicate-interface collisions. Never hand-edit the generated TS.

Schema dir is resolved relative to this file so it runs from any cwd.
"""

import json
import os

from pydantic.json_schema import models_json_schema

from .models import ErrorEnvelope, Job, JobEvent, JobRequest, JobResponse, Loop

# apps/worker/src/worker/codegen.py -> packages/types/schema
SCHEMA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "packages", "types", "schema")
)
OUT_FILE = os.path.join(SCHEMA_DIR, "contract.schema.json")

MODELS = [Job, JobRequest, Loop, JobEvent, JobResponse, ErrorEnvelope]


def build_schema() -> dict:
    _map, combined = models_json_schema(
        [(m, "validation") for m in MODELS],
        ref_template="#/$defs/{model}",
    )
    defs = combined.get("$defs", {})
    # Wrapper root forces json-schema-to-typescript to emit every model interface once.
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "StemLoopsContract",
        "type": "object",
        "properties": {name: {"$ref": f"#/$defs/{name}"} for name in sorted(defs)},
        "required": sorted(defs),
        "additionalProperties": False,
        "$defs": defs,
    }


def run() -> None:
    os.makedirs(SCHEMA_DIR, exist_ok=True)
    schema = build_schema()
    with open(OUT_FILE, "w") as f:
        json.dump(schema, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"  wrote {OUT_FILE} ({len(schema['$defs'])} types)")


if __name__ == "__main__":
    run()
