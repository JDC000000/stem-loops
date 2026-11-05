# Y1 production-readiness checklist

> Jon-facing checklist for the `CHORDS_PROVIDER=klangio → CHORDS_PROVIDER=internal`
> flip (P2-6). Every box is pass/fail: the flip does not happen until all
> boxes are checked. Cross-references the decision record v1.5
> (`claude/phase-2-y1-chord-model-decision.md`) and the Y1 open-questions doc
> (`claude/phase-2-y1-open-questions-recommendations.md`).
>
> Three sibling docs: `modal-signup-prep.md` (pre-flight), `y1-first-training-run.md`
> (the first real run), and this file (what "ready" means).

The flip itself is a single env change in production:

```bash
# apps/worker/.env (prod)
- CHORDS_PROVIDER=klangio
+ CHORDS_PROVIDER=internal
```

Everything below is what must be true **before** that env change lands.

---

## 1. Model-quality gates (decision record v1.5)

Measured on the frozen 20-song eval set in
`apps/training/eval.py`, using the factored alphabet from PR-Y1.4b.

- [ ] **MajMin accuracy ≥ 78% absolute** on 20-song eval (mean over
      3 shuffle seeds).
- [ ] **7ths accuracy ≥ 65% absolute** on 20-song eval (mean over
      3 shuffle seeds).
- [ ] **Within 5% of Klangio reference** on the same 20 songs (MajMin
      head-to-head; Klangio is the baseline the user is already paying for).
- [ ] **3 independent shuffle runs** reported with **mean + stddev** —
      a single-seed number does not pass this gate.
- [ ] **Per-song floor: no song below 50% MajMin.** If any song in the
      20-song eval collapses, investigate before shipping — one 10%-MajMin
      song in production will produce a visibly broken overlay.
- [ ] **Bass accuracy ≥ 50%** on the factored bass head (PR-Y1.4b). The
      factored alphabet's whole point is keeping slash chords; the bass
      head's floor must hold.
- [ ] **Alphabet normalizer coverage ≥ 95%** — i.e. ≥95% of ChoCo /
      McGill Billboard reference chords map cleanly through
      `apps/training/model/alphabet.py::encode_factored` with no `N` or
      silent drop. Measured by `scripts/alphabet_collapse_audit.py`.

---

## 2. Deployment gates (export + browser)

Measured on the PR-Y1.5b export pipeline and PR-Y1.6 browser integration.

- [ ] **ONNX int8 export ≤ 10 MB.** File size check on
      `apps/training/dist/chordnet.int8.onnx` — hard ceiling because Variant Y
      ships the model over the wire.
- [ ] **CQT parity test passes** (<1e-3 max abs vs librosa reference on
      the fixtures under `apps/training/tests/fixtures/cqt_parity/`).
      `pytest apps/training/tests/test_cqt_parity.py` green.
- [ ] **Browser-side CQT ↔ server-side librosa parity** — the fixture
      pair shipped in PR-Y1.5b (`apps/web/tests/cqt-parity/*`) — passes in
      the web test suite.
- [ ] **ORT Web WebGPU path works on desktop Chrome** (latest stable).
      Model loads, one inference completes, output root prediction matches
      the Node ONNX Runtime baseline within quantization tolerance.
- [ ] **ORT Web WASM-SIMD fallback works on desktop Chrome** — forced via
      the `wasm-only` flag — same accuracy within tolerance. The fallback
      must work before the WebGPU path can be shipped as primary.
- [ ] **Adreno 6xx / 750 parity gate.** The PR-Y1.6 smoke flow forces WASM
      when WebGPU output diverges > 1e-3 from WASM on the same input, which
      covers the known broken Adreno drivers; the gate is that the forced-WASM
      branch is reached and produces correct output.
- [ ] **iOS Safari smoke test** (PR-Y1.6 fixup): WASM-SIMD-only path
      works end-to-end, peak memory < 500 MB (iOS Safari will terminate the
      tab above that).

---

## 3. Operational gates (data, release, rollback)

- [ ] **`apps/training/DATA-PROVENANCE.md` complete** for every training
      source. Each row must have: source name, URL, license, SHA-256 of the
      archive, Y1 use (train / eval / both), and the date the hash was
      captured. No `TODO` rows.
- [ ] **Open-source release artifacts prepared** at
      `jdc000000/chordmini-clean` (companion repo):
      - Apache-2.0 **weights** (`chordnet.int8.onnx` + `chordnet.fp32.onnx`)
      - **Training recipe** (config YAML + commit SHA of the training run)
      - **20-song eval manifest** (song IDs + per-song MajMin / 7ths
        numbers from the mean-of-3-shuffles report)
- [ ] **Decision record v1.5 referenced in release notes** — a one-line
      pointer so future-Jon finds the rationale: `See
      claude/phase-2-y1-chord-model-decision.md for the
      why-this-architecture / why-this-alphabet trail.`
- [ ] **Rollback plan: < 1 min to flip back to klangio.** The only
      production touchpoint is `CHORDS_PROVIDER` in
      `apps/worker/.env`; redeploy the worker (Fly.io `fly deploy` or
      equivalent) and klangio is primary again. Document the exact
      command in the release PR description so an on-call future-Jon does
      not have to re-derive it at 2am.

---

## 4. Legal gates

These are not optional — shipping an "internal" chord model without them is
the exact failure mode the Y1 pre-mortem flagged.

- [ ] **Burgoyne email reply received** confirming McGill Billboard
      canonical distribution (ChoCo CC BY 4.0 lineage). Reply archived in
      `claude/correspondence/burgoyne-mcgill-billboard-outreach.md`.
- [ ] **Klangio API ToS captured (H-2)** in
      `claude/vendor-tos/klangio-api.md` — full readout, fetch date, and
      the §12.5 "no-train-on-outputs" clause verbatim. Companion to the
      existing `klangio-general-tou-readout.md`.
- [ ] **No training on Klangio outputs** verified in the training
      pipeline — grep the training manifests and `training.data.sources`
      for any Klangio-produced labels; the verification note goes in
      `DATA-PROVENANCE.md` at the top.
- [ ] **CRA GST / DMCA briefs noted as "deferred until 10 paying users"**
      in `claude/project-tracker.md`. These are documented-deferred, not
      ignored — the briefs under `claude/phase-5-*.md` remain the
      activation plan when the user threshold trips.

---

## 5. Flywheel readiness

The chord-edit flywheel is what makes the internal model get *better* over
time; without it, the switch to internal locks in current-day accuracy.

- [ ] **Migration 025** (`apps/worker/migrations/025_v3_chord_edits.sql`)
      applied to Supabase **staging** and **prod**. Verify with `supabase
      db diff` or by querying `information_schema.tables` for
      `chord_edits`.
- [ ] **First ≥ 10 `chord_edits` rows** captured from real staging usage
      — a sanity check that the UI → API → DB path is actually writing,
      not that the schema compiles. Spot-check that `before_chord`,
      `after_chord`, `song_id`, `user_id`, `created_at` are populated.
- [ ] **Weekly re-training cron plan drafted** in
      `docs/ops/chord-edit-flywheel.md`. Implementation is
      **deferred until ≥ 100 `chord_edits` rows** exist — shipping the
      cron before there is signal just burns Modal credit on noise.

---

## 6. Flip procedure (for reference)

Once every box above is checked:

1. Open PR titled `[v3-phase-2] chore(y1): flip CHORDS_PROVIDER=internal (P2-6)`.
2. Single change: `apps/worker/.env`
   `CHORDS_PROVIDER=klangio` → `CHORDS_PROVIDER=internal`.
3. Link this doc (filled-in, every box ticked) in the PR description.
4. `scripts/safe_merge.sh <N>` — AGENTS.md §11 M-1 still applies.
5. Watch Langfuse (`docs/ops/langfuse-tracing.md`) for the first hour:
   latency, error rate, and a spot-check on 3 songs the Klangio path
   handled well.
6. If anything looks off, flip back: change the env, redeploy worker. The
   rollback target is under 1 min per §3 above.
