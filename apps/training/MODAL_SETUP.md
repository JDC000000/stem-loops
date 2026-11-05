# Modal Setup for Y1 Chord-Model Training

> First-time setup and day-to-day operation of the `stem-loops-chordnet`
> Modal app. Companion to `apps/training/MODAL_BILLING.md` (billing &
> preemption rules) and `apps/training/modal_app.py` (the app itself).
>
> **Scope of this PR:** infrastructure only. No actual Modal auth or remote
> run from the PR that landed this file.

---

## 1. One-time setup

```bash
# 1) Install Modal client (version matches apps/training/pyproject.toml)
pip install 'modal>=0.65'

# 2) Authenticate (opens browser, pastes token into ~/.modal.toml)
modal setup

# 3) Deploy the app's functions so remote invocations work
#    (optional — `modal run` auto-deploys on each call)
modal deploy apps/training/modal_app.py
```

If `modal setup` is skipped you'll get a `ModalError: missing credentials`
on the first `modal run`. Credentials live only on the invoking workstation;
do not commit `~/.modal.toml`.

---

## 2. Shared volume strategy

One named Modal Volume, `chordnet-data`, carries three kinds of files:

| Path on volume | Contents | Written by | Read by |
|----------------|----------|------------|---------|
| `/data/cache/` | Synthetic MusicXML-rendered corpus + real-chord subsets | one-time upload | `train_chordnet` |
| `/data/checkpoints/` | Rolling training snapshots (see `preemption.py`) | `train_chordnet` | `eval_chordnet`, local pull |
| `/data/eval/` | `eval_<ts>.json` metric dumps | `eval_chordnet` | local pull |

The volume is declared in `modal_app.py` with
`modal.Volume.from_name("chordnet-data", create_if_missing=True)`, so a
fresh account auto-creates it on the first `modal run`.

**Budget (free tier):** Modal Volumes are `$0.09 / GiB / mo` with `1 TiB /
mo free` (pricing page, 2026-11-04). Projected footprint is <50 GiB — well
inside the free band. See `MODAL_BILLING.md` §7.

### Upload the corpus cache

```bash
# After `apps/training/scripts/build_corpus.py` has written the cache locally
modal volume put chordnet-data ./apps/training/data/cache /
```

### Pull a checkpoint back for local eval

```bash
# Latest best
modal volume get chordnet-data /checkpoints/best.pt ./local/

# All checkpoints from a run
modal volume get chordnet-data /checkpoints/ ./local/checkpoints/
```

Egress is `$0.04 / GiB` and a chord-model checkpoint is <200 MB, so pulling
every checkpoint from a 10-run wave costs ~$0.08.

### Clear corpus for a fresh build

```bash
modal volume rm chordnet-data /cache --recursive
```

---

## 3. Running a training pass

The one-command wrapper (preferred):

```bash
./scripts/modal_train.sh --gpu l4 --epochs 30 --seed 42
```

Direct Modal CLI:

```bash
modal run apps/training/modal_app.py::train_chordnet \
    --config-path configs/chordnet_2e1d_v1.yaml \
    --epochs 30 \
    --seed 42
```

Both paths invoke `train_chordnet` with the same signature. The function
returns a `{"status": "ok", "stdout_tail": "...", ...}` dict that prints to
the local shell when `--detach` is not set.

### Escalating to a bigger GPU

Edit the `@app.function(gpu="L4", ...)` line in `modal_app.py` to one of
`"A10"`, `"A100-40GB"`, `"A100-80GB"`. See `GPU_PROFILES` for the
canonical mapping. The bash wrapper's `--gpu` flag is a hint today; Modal
reads the GPU type off the decorator, so flipping the decorator value is
the actual switch.

For a one-off GPU swap without editing the file:

```bash
# Modal supports overriding the GPU on the CLI via `modal run --gpu`
modal run apps/training/modal_app.py::train_chordnet --gpu A10
```

---

## 4. Running an evaluation pass

```bash
modal run apps/training/modal_app.py::eval_chordnet \
    --checkpoint-name chordnet_1762276800.pt
```

`eval_chordnet` is CPU-only (`cpu=4.0`, no GPU) because the chord model is
small enough that CPU inference on the eval set takes a few minutes and
costs ~$0.01 vs. ~$0.05 on L4. It reads from the same volume and writes
`eval/eval_<ts>.json` back to it.

---

## 5. Preemption behaviour

- Modal GPU Functions **cannot** opt out of preemption
  (`nonpreemptible=True` is rejected — see `MODAL_BILLING.md` §3).
- `train_chordnet` is designed restart-safe via `preemption.py`: a SIGTERM
  handler snapshots the model + optimizer + RNG + epoch counter once more
  into `/data/checkpoints/` before the container is killed, and the next
  restart finds that checkpoint and resumes.
- The checkpoint cadence inside the loop is **every 5 minutes** of
  wall-clock by default.
- Modal restarts a preempted Function *"on the same input"*, so the
  `train_chordnet(config_path=..., epochs=30, seed=42)` call stays
  deterministic across restarts. `seed` is passed through to the training
  script and reseeds Python + torch RNG on entry; the checkpoint restores
  RNG state on resume.

---

## 6. Cost estimation

```bash
python scripts/modal_cost_estimate.py --gpu l4 --hours 4 --runs 10
# → estimated $32.00 compute + ~$0.08 egress + ~$0.00 storage
```

See `MODAL_BILLING.md` §9 for the full cost table across L4 / A10 /
A100-40.

---

## 7. Teardown

To wind the app down between training waves without losing the corpus:

```bash
modal app stop stem-loops-chordnet     # stops running containers
# volume stays; no action needed
```

To nuke everything (careful — this deletes the corpus):

```bash
modal app stop stem-loops-chordnet
modal volume delete chordnet-data
```
