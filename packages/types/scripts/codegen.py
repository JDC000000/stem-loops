#!/usr/bin/env python3
"""Pydantic → TypeScript codegen (canonical contract).

Emits TS interfaces DIRECTLY from the Pydantic field annotations — deterministic,
no external json-schema-to-typescript dependency. Single source of truth:
apps/worker/src/worker/models.py. Regenerate with `make types-generate`.
"""

from __future__ import annotations

import datetime as _dt
import sys
import typing
import uuid
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
OUTPUT_FILE = SCRIPT_DIR.parent / "src" / "generated.ts"

_PRIM = {str: "string", int: "number", float: "number", bool: "boolean"}


def _ts_base(ann, names: set[str]) -> str:
    origin = typing.get_origin(ann)
    args = typing.get_args(ann)
    if origin is typing.Union:  # includes Optional[X]
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            return _ts_base(non_none[0], names)
        return " | ".join(_ts_base(a, names) for a in non_none)
    if origin in (list, tuple):
        return f"{_ts_base(args[0], names)}[]"
    if ann in _PRIM:
        return _PRIM[ann]
    if ann in (uuid.UUID, _dt.datetime):
        return "string"
    name = getattr(ann, "__name__", None)
    return name if name in names else "unknown"


def _emit(name: str, model, names: set[str]) -> str:
    out = [f"export interface {name} {{"]
    for fname, field in model.model_fields.items():
        ann = field.annotation
        nullable = typing.get_origin(ann) is typing.Union and type(None) in typing.get_args(ann)
        optional = nullable or not field.is_required()
        ts = _ts_base(ann, names) + (" | null" if nullable else "")
        out.append(f"  {fname}{'?' if optional else ''}: {ts};")
    out.append("}")
    return "\n".join(out)


def main() -> None:
    # Import the CANONICAL models (src/worker/models.py).
    sys.path.insert(0, str(REPO_ROOT / "apps" / "worker"))
    from src.worker.models import (  # type: ignore  # noqa: E402
        ErrorEnvelope,
        Job,
        JobEvent,
        JobRequest,
        JobResponse,
        Loop,
    )

    # Order matters: referenced models (Loop, JobEvent) precede Job; Job precedes JobResponse.
    models = {
        "JobRequest": JobRequest,
        "ErrorEnvelope": ErrorEnvelope,
        "Loop": Loop,
        "JobEvent": JobEvent,
        "Job": Job,
        "JobResponse": JobResponse,
    }
    names = set(models)

    parts = [
        "// AUTO-GENERATED — DO NOT EDIT",
        "// Source of truth: apps/worker/src/worker/models.py",
        "// Regenerate with: make types-generate",
        "",
    ]
    for n, m in models.items():
        parts.append(_emit(n, m, names))
        parts.append("")

    OUTPUT_FILE.write_text("\n".join(parts))
    print(f"TypeScript types written to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
