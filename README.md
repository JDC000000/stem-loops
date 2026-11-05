# stem-loops

Turn any YouTube song into bar-aligned, BPM-detected loops. Drums, bass, vocals, guitar, keys.

Live at [stem-loops.vercel.app](https://stem-loops.vercel.app).

## Context for contributors (and agents)

Start with [`AGENTS.md`](./AGENTS.md) — the single canonical context file for this repo. It covers the architecture overview, build order, state machine, error codes, anti-goals, and the secret convention. All agents (Claude Code, Cursor, Copilot, CI bots) read it first.

## Architecture

Deep-dive architecture docs live in [`docs/architecture/`](./docs/architecture/). Each major subsystem gets one doc:

- [`docs/architecture/v3-y1-chord-recognition.md`](./docs/architecture/v3-y1-chord-recognition.md) — V3-Phase-2 Y1 chord-recognition stack: paid-path overlay (Klangio bridge) + free-tier live overlay (own-trained ChordNet student), eval gate, flywheel, legal readout.

Operational runbooks sit beside them in [`docs/ops/`](./docs/ops/). Spec and spike notes sit in [`docs/specs/`](./docs/specs/) and [`docs/spikes/`](./docs/spikes/). See [`docs/architecture/README.md`](./docs/architecture/README.md) for the full index.

Decision records and research reports live in the attached Claude Project, not on disk.
