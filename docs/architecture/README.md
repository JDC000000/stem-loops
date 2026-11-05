# stem-loops — Architecture docs

Single-file architecture write-ups for each major stem-loops subsystem. One doc per subsystem; each doc is the entry point a contributor reads cold.

If you cannot find something below, the two canonical cross-cutting files remain:

- [`/AGENTS.md`](../../AGENTS.md) — repo context, build order, anti-goals, secret convention. Always read this first.
- `claude/phase-2-y1-chord-model-decision.md` and the TSD — project docs (read through the Projects tool, not the filesystem).

## Architecture docs in this folder

| Doc | Subsystem | Status |
|---|---|---|
| [`v3-y1-chord-recognition.md`](./v3-y1-chord-recognition.md) | V3-Phase-2 Y1 chord-recognition stack (paid P2-6 overlay + free-tier Variant Y) | Living — authored 2026-11-04, tracks decision v1.3 |

## Operational runbooks (`docs/ops/`)

Operational detail — what to do when something breaks, how to run a job by hand — lives in `docs/ops/`. The architecture docs above link to the runbooks they cover; the full index:

- [`docs/ops/ai-gateway.md`](../ops/ai-gateway.md) — AI gateway
- [`docs/ops/langfuse-tracing.md`](../ops/langfuse-tracing.md) — Langfuse tracing hook (Fleet Move 2, PR #68)
- `docs/ops/chord-recognition.md` — ChordSource + Klangio provider runbook (lands in PR #73)
- `docs/ops/chord-smoothing.md` — JS-side Viterbi smoother runbook (lands in PR #79)
- `docs/ops/synthetic-render.md` — synthetic corpus renderer runbook (lands in PR #74)
- `docs/ops/model-training.md` — ChordNet training runbook (lands in PR #77)

## Specs (`docs/specs/`)

Component-level specs captured during build:

- [`docs/specs/V3-M-emails.md`](../specs/V3-M-emails.md)
- [`docs/specs/V3-U2-claim-jobs.md`](../specs/V3-U2-claim-jobs.md)

## Spike notes (`docs/spikes/`)

Short investigation write-ups, S1…S5, in [`docs/spikes/`](../spikes/).

## Decision records (project docs)

Decision records and research live in the attached Claude Project, not on disk. Read them with `project_read`:

- `claude/phase-2-y1-chord-model-decision.md` — Y1 canonical decision, v1.3
- `claude/phase-2-y1-chord-model-synthesis.md`, `-premortem.md`, `-redteam-alphabet-cqt.md`
- `claude/phase-2-y1-chord-model-research-*.md` — research reports (broad, foundations, data, rea, devils-advocate)
- `claude/phase-2-y1-open-questions-recommendations.md`
- `claude/phase-2-v3-y1-chord-overlay-plan.md`

## TSD

The TSD is also a project doc (not on disk). Sections most relevant to the architecture docs here:

- §1.5a — chords
- §1.6a — chord-edit flywheel
- §5.4 — browser deployment matrix
- §6 — data model (jobs / job_events / loops)
- §9 — build order
