# Modal Billing & Preemption Notes (PR-Modal-Setup)

> **Why this file exists.** Red-team pre-mortem for the Y1 chord model
> (`claude/phase-2-y1-chord-model-premortem.md`) flagged *Modal billing-cycle
> semantics for preempted long runs* as unknown-unknown #1. This file captures
> the verbatim rules from Modal's docs so the Week-3 training burn
> ($30-$80 compute, 5-10 runs on L4 per decision record v1.3) has no surprise
> billing or lost-progress blow-ups.
>
> **Fetch date:** 2026-11-04. Re-verify before every training wave — Modal
> pricing and preemption semantics change without notice. See §8 for refresh
> procedure.

---

## 1. Source URLs

| # | URL | Fetched |
|---|-----|---------|
| 1 | https://modal.com/docs/guide/billing | 2026-11-04 |
| 2 | https://modal.com/docs/guide/preemption | 2026-11-04 |
| 3 | https://modal.com/docs/guide/gpu | 2026-11-04 |
| 4 | https://modal.com/docs/guide/cold-start | 2026-11-04 |
| 5 | https://modal.com/pricing | 2026-11-04 |

---

## 2. Billing granularity (short runs)

**Question:** How does billing round for runs under one minute?

**Verbatim from Modal billing docs:** *"there are no minimum usage-time
increments"* (https://modal.com/docs/guide/billing, 2026-11-04).

**Verbatim from Modal pricing page (2026-11-04):** GPU, CPU, and memory are
all quoted per-second. L4 is `$0.000222 / sec`. CPU is `$0.0000131 / core /
sec`. Memory is `$0.00000222 / GiB / sec`.

**Implication:** Billing is per-second with no minimum. A 30-second cold-boot
dry-run on L4 costs `30 × $0.000222 = $0.00666`. We should not avoid tiny
smoke-test runs on L4 out of billing fear; the dominant cost will be the
multi-hour real training runs.

---

## 3. Preemption semantics

**Question:** What happens to a preempted L4 run — do we pay for the partial
window?

**Verbatim from Modal preemption docs (2026-11-04):**

- *"Modal will gracefully terminate the Function and restart it on the same
  input."*
- *"[Modal] will send an interrupt signal to your container when preemption
  occurs"* (which runs the Function's exit handler within its grace period).
- Under **Non-preemptible Functions**: *"The `nonpreemptible` parameter is not
  supported for GPU Functions."*
- Under **Non-preemptible Sandboxes**: *"Modal Sandboxes are not subject to
  preemption, except in the case where a `gpu` requirement is specified."*

**Verbatim preparation guidance from the same page:**

- *"Divide long-running operations into small tasks or use checkpoints so
  that you can save your work frequently."*
- *"Ensure preemptible operations are safely retryable (ie. idempotent)."*

### What the docs do NOT state (as of 2026-11-04 fetch)

- Whether the user is billed for compute time *before* preemption.
- The retry policy (count, backoff) that governs the automatic restart.
- Which GPU types or regions are more subject to preemption.

### Operational decision

Treat the pre-preemption window as **billed** until Modal confirms
otherwise — budget on the conservative side. Design all training runs to be
**restart-safe** (deterministic seed, checkpoint every 5 min, resume from
latest checkpoint). See `apps/training/preemption.py` for the module the
training script must call.

**Hard rule:** GPU Functions on Modal cannot opt out of preemption
(`nonpreemptible=True` is rejected for GPU jobs). There is no "pay more to
avoid preemption" lever for L4/A10/A100 on Modal. Checkpointing is the only
mitigation.

---

## 4. Cold-boot latency (L4)

**Question:** What's the typical cold-boot latency for an L4?

**Verbatim from Modal cold-start docs (2026-11-04):**

- *"Containers boot in about one second."*
- *"The time taken for a container to become warm and ready for inputs can
  range from seconds to minutes."* (Larger models pull weights into memory
  during boot.)
- Pre-downloading weights into the image or a Volume cuts boot times *"from
  minutes to seconds"* for multi-tens-of-GB models.

**The cold-start page gives no per-GPU figures; L4 is not quoted
separately.** Expectation for the chord model: image is small (PyTorch +
mir_eval + librosa + a few MB of checkpoint on first run), so boot should be
in the **single-digit-seconds** range. Budget 30 s per cold boot in cost
estimates.

---

## 5. Free tier / signup credit

**Verbatim from Modal pricing page (2026-11-04):** *"Starter plan includes
`$30 / month free credits`."* Site meta description: *"Start with $30/month
in free compute."*

**Implication:** On the Starter plan Jon already receives $30 of compute per
month at no charge, renewing monthly. The Week-3 budget band
($30-$80 total for 5-10 L4 runs) means the first full wave likely fits
inside the free allowance. Plan the dispatch so Week-3 runs land in a single
calendar month to maximize that.

---

## 6. Egress / bandwidth

**Question:** Egress charges for downloading checkpoints from Modal back to
local?

**Verbatim from Modal pricing page (2026-11-04):** **Network egress:
`$0.04 / GiB`**. The billing page refers to a *"network egress
allowance"* without quoting its size.

**Implication:** A trained chord-model checkpoint will be on the order of
tens of MB (2 encoder + 1 decoder + optimizer state, probably <200 MB).
Downloading even 10 checkpoints is a rounding error on egress cost
(~$0.08). We can afford to pull every best checkpoint locally; no need for
hub-only storage.

---

## 7. Storage (Modal Volumes)

**Verbatim from Modal pricing page (2026-11-04):** **Volumes: `$0.09 / GiB /
mo`, with `1 TiB / mo free`.**

**Implication:** The `chordnet-data` volume will carry: synthetic
MusicXML-rendered corpus (probably 5-20 GiB of flac), a small real-chord
subset (McGill Billboard etc., maybe 5-10 GiB), and checkpoints
(≤5 GiB). Total projected footprint: **<50 GiB**, inside the free tier by
20× margin. Storage is not a cost driver.

---

## 8. Refresh procedure

Before every training wave, re-verify the five pages in §1 with a fresh
WebFetch:

```
WebFetch https://modal.com/pricing \
  "Extract L4 price, free tier size, egress rate, volume storage rate"
WebFetch https://modal.com/docs/guide/preemption \
  "Extract preemption billing + retry policy"
```

If any number changed, update the relevant section and bump the fetch date
at the top. Commit with footer `docs(training): refresh Modal billing from
upstream YYYY-MM-DD`.

---

## 9. Cost table — projected Week-3 burn

Assumes L4 `$0.000222 / sec` × 3600 = `$0.80 / h` (matches decision record
v1.3 §dispatch).

| GPU | $ / h | 1 run (2 h) | 5 runs | 10 runs |
|-----|-------|-------------|--------|---------|
| L4 | $0.80 | $1.60 | $8 | $16 |
| L4 | $0.80 | $3.20 (4 h) | $16 | $32 |
| A10 | $1.10 | $2.20 | $11 | $22 |
| A10 | $1.10 | $4.40 (4 h) | $22 | $44 |
| A100-40 | $2.10 | $4.20 | $21 | $42 |
| A100-40 | $2.10 | $8.40 (4 h) | $42 | $84 |

With the $30/mo Starter credit, a 10-run L4 wave at 2 h/run (`$16`) runs
net-free. The decision record's $30-$80 band maps to the A100-40 upper rail
plus egress + a couple of restarts.

See `scripts/modal_cost_estimate.py` for the live calculator.
