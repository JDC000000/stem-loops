# Worker Tests

Run with `pytest apps/worker/tests/ -v` or `make test`.

## Test categories

- **Unit**: pure function tests (models, error taxonomy, redaction, seamless algorithm)
- **Integration**: DB-backed tests (migrations, queue consumer, job state machine)
- **Golden-file / rubric**: audio pipeline accuracy (BPM, key, boundary detection, S5 seam)
- **Security**: secret-redaction, no-stack-trace-in-response, SSRF allowlist

## Phase 4 CI fixture test (T30)

The full pipeline fixture test (cached YouTube audio, no live API calls, every typed error triggered) is added in Phase 4 T30. See AGENTS.md for the CI workflow.

## Fixtures (operator-provided — not committed until Gate 0)

- `fixtures/golden_loop.wav` — S5 seam unit tests
- `fixtures/labeled_song.mp3` + `labeled_song_ground_truth.json` — S3/S4 accuracy
- `fixtures/neosoul_keys.mp3` — S4 keys→piano validation
- `fixtures/fixture_urls.txt` — S1 50-URL bake-off
