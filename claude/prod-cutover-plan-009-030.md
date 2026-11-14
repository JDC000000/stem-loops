# Production cutover plan — migrations 009 → 030

**Target:** Supabase project `qthrhamfljhifhfwvvwj` (production; confirmed by `docs/RESTORE-stem-loops-com-2026-11-02.md`).
**Source:** repo `v3/main` at `25d0934` (2026-11-06). Every statement below was read from the actual SQL in `apps/worker/migrations/` and `apps/worker/migrations/down/`, and from `apps/worker/src/worker/migrate.py`.
**Rehearsal evidence:** a parallel session ran the repo runner against a clean local Postgres 16.15 (001–008 first, then 009–030). Results are cited inline as **[rehearsed]**. Everything else is a static read of the code **[static]**. Where the two disagree it is said so in §4.6.
**Status:** **REHEARSED end-to-end on a real Supabase replica, 2026-11-06.** 009→031 applied and verified. One blocker was found and fixed (012; see §9). **§9 lists five corrections that supersede statements below — read it first.**

---

## 0. Handoff — the five things to know before touching anything

1. **The SQL chain is sound; the risk is around it.** 009→030 applied cleanly to a fresh 008-state database with zero interventions, in 0.32 s, and re-running was a no-op **[rehearsed]**. Nothing in 009–030 deletes, rewrites or type-changes any existing production row. Every change to the three hot tables (`jobs`, `loops`, `job_events`) is additive: two nullable columns on `jobs`, RLS/policies, and FKs *into* `jobs` from new tables.
2. **Production's current data is ephemeral.** `jobs`/`loops`/`job_events` expire after 24 h (migration 007); `kill_switches`, `blocklist`, `fetch_attempts` are small and re-creatable. So the point of no return is **not** the migration — it is the **first real user row** (sign-up, purchase, chord edit) written after the web deploy enables accounts. Until then, every migration can be fully undone by dropping empty tables. After it, "rollback" means rolling back *code* and keeping the schema.
3. **Two things in production will break on code deploy regardless of the schema, and nobody has checked them:**
   - `POST /api/jobs` (the anonymous upload path — the core product) calls `getUser()` unconditionally; without `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel **production** env it throws and every job creation returns 500. The 2026-11-02 restore doc's prod env list does not contain them.
   - Account deletion (`DELETE /api/users/me`) runs `DELETE FROM public.chord_edits` through the app's DB connection. If that connection is `stemloops_app`, it fails with `permission denied` (025 revokes DELETE on purpose) **after** cancelling the Stripe subscription and tombstoning the user **[rehearsed privilege, static route read]**. Blocking pre-flight item: confirm which role the web app connects as.
4. **Order is forced in four places:** 009+011 must land as one unit (a pause between them can lock the worker out if prod's policies are not what 011's header claims); 013 before any authed web traffic; **028 and 030 before the worker deploy** (new worker on old schema loses every chord as a silent `provider_failed`); 025 before 026/027/029.
5. **The `_migrations` ledger is the only record of state, and the down files (except 009/011) do not maintain it.** After any hand rollback you must `DELETE FROM _migrations WHERE filename = …` or the next run silently skips the file **[rehearsed: after downing 029/030 the runner skipped both and `klangio_job_id` stayed absent]**. Correct post-cutover count is **29 rows** (001–009, 011–030; there is no 010), not 30.

Tooling note: `psql` and `fly` are **not** installed on the operator's machine. The plan is written for the Supabase Dashboard SQL editor (or the Supabase connector's `execute_sql`) plus the Vercel/Fly/Stripe dashboards. The repo runner (`make migrate`) is the alternative where Python + `psycopg` exist; see §5.1.

---

## 1. How the runner actually behaves (`apps/worker/src/worker/migrate.py`)

Read this even if you will paste SQL by hand, because the by-hand procedure must reproduce it.

| Behaviour | What the code does |
|---|---|
| Discovery | `sorted(glob("apps/worker/migrations/*.sql"))` — lexical order, top level only. `down/` is never globbed. Missing `010` is irrelevant to it. |
| Ledger | `CREATE TABLE IF NOT EXISTS _migrations(filename text PRIMARY KEY, applied_at timestamptz DEFAULT now())`, then per file `SELECT 1 FROM _migrations WHERE filename=%s` → skip if present. **No checksum**: an edited file that is already recorded is never re-applied. |
| Transaction boundary | One implicit psycopg transaction **per file**. Statements are split on top-level `;` (respecting strings, `$$` bodies, comments) and executed one at a time; then `INSERT INTO _migrations(filename)`; then `conn.commit()`. The ledger row is in the same transaction as the DDL. |
| Partial failure | Any statement error raises out of `run()`; the `with psycopg.connect()` block exits via exception → rollback → connection closed. The failing file leaves **nothing** behind and is **not** recorded; all earlier files stay committed; later files are not attempted. Re-running resumes at the failed file. |
| Role | Whatever `DATABASE_URL` says. Makefile default is `postgresql://stemloops:stemloops@localhost:5432/stemloops` — if you forget to export `DATABASE_URL` it fails harmlessly against localhost. |
| Idempotency | Confirmed: 2nd and 3rd runs printed `skip … (already applied)` for all 29, exit 0, `applied_at` unchanged **[rehearsed]**. |

Consequence for hand-application: **each file = one `BEGIN … <file> … INSERT INTO _migrations … COMMIT`.** Never record a file whose statements did not all succeed; never leave a file applied but unrecorded.

---

## 2. Per-migration table

Legend — *Hot lock*: lock taken on `jobs`/`loops`/`job_events`. *Offline?*: whether live traffic must stop. *Destructive?*: to data that exists in prod today (none of 009–030 is).

| # | File | What it creates / changes | Reversible? | `down/` exists? | Needs app offline? | Destructive to existing data? | Notes |
|---|---|---|---|---|---|---|---|
| 009 | `009_rls_catchup.sql` | `CREATE ROLE service_role NOLOGIN` if absent (no-op on Supabase). On the 7 V2 tables (`jobs, job_events, loops, upload_rate_events, kill_switches, blocklist, fetch_attempts`): `ENABLE ROW LEVEL SECURITY`; `REVOKE ALL … FROM PUBLIC`; `GRANT ALL … TO service_role`; policy `<table>_service_role_all FOR ALL TO service_role USING(true) WITH CHECK(true)`. | Partly. The policies and RLS flag can be dropped; the prior ACL (what PUBLIC had) is not recorded anywhere. | Yes — **but do not run it**: it ends with `GRANT ALL ON <table> TO PUBLIC` on all 7 tables and `DISABLE ROW LEVEL SECURITY`, which is a security regression, not a restore. It does delete its ledger row. | No. Brief `ACCESS EXCLUSIVE` on each hot table (ENABLE RLS, CREATE POLICY) — milliseconds. | No | **Must be applied in the same transaction as 011** (see §4.1). Superseded by 011 immediately. |
| 011 | `011_role_catchup.sql` | `CREATE ROLE stemloops_app NOLOGIN` if absent (prod already has it as LOGIN per header); `GRANT USAGE ON SCHEMA public TO stemloops_app`; drops 009's `<table>_service_role_all` and `REVOKE ALL … FROM service_role` on the 7 tables; on the 7 tables `ENABLE RLS`, `DROP/CREATE POLICY stemloops_app_all FOR ALL TO stemloops_app USING(true) WITH CHECK(true)`, `GRANT SELECT,INSERT,UPDATE,DELETE TO stemloops_app`; `GRANT USAGE,SELECT ON ALL SEQUENCES`; `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT S/I/U/D ON TABLES` and `USAGE,SELECT ON SEQUENCES` to `stemloops_app`; **if role `cowork_ro` exists**: `CREATE POLICY cowork_ro_read FOR SELECT TO cowork_ro USING(true)` on **every** table in `public` (including `_migrations` and the 008 tables). | Partly. Policies/grants reversible by hand; prior state unknown; default-privileges change affects every table created afterwards by the same role. | Yes — but its down **re-creates the 009 `service_role` policies and `REVOKE ALL … FROM stemloops_app`**, i.e. it locks the production worker out if it connects as `stemloops_app`. Deletes its ledger row. | No. Brief `ACCESS EXCLUSIVE` per table (policies). | No | Default privileges are role-scoped: they apply to tables later created **by the same role that ran 011**. Run all migrations as one role (§7). |
| 012 | `012_v3_supabase_stubs.sql` | `CREATE SCHEMA IF NOT EXISTS auth`; `CREATE TABLE IF NOT EXISTS auth.users(…)`; `CREATE ROLE authenticated/anon NOLOGIN` if absent; `CREATE FUNCTION auth.uid()` returning NULL **only if** `auth.uid` is absent in `pg_proc`. | Yes (nothing to reverse on Supabase). | Yes; guarded — drops `auth.users` only if it lacks `instance_id`, i.e. only the stub. No ledger delete. | No. Touches nothing hot. | No | Designed as a no-op on Supabase. **Caveat [static]:** `CREATE TABLE IF NOT EXISTS auth.users` still performs the schema CREATE-privilege check before the IF-NOT-EXISTS short-circuit; if the executing role lacks CREATE on `auth`, 012 errors with `permission denied for schema auth`. Rehearsal on bare Postgres cannot show this. If it happens on the rehearsal copy, the sanctioned deviation is to record 012 in `_migrations` without running it (all four stubs already exist on Supabase) — write that down in the cutover log. |
| 013 | `013_v3_commercial.sql` (108 statements) | `CREATE ROLE stemloops_app` guard; `CREATE EXTENSION IF NOT EXISTS citext`. **10 new tables**, each with RLS + `authenticated` self-read policy (`auth.uid() = user_id/id`) + `stemloops_app` policy + grants: `users(id FK auth.users ON DELETE CASCADE, email citext UNIQUE, display_name, marketing_opt_in)`; `plans(code PK, display_name, price_cad_cents, monthly_job_quota, services text[], export_stems, export_wav24, active)` with `plans_public_read FOR SELECT TO anon,authenticated USING(active)`; `customers_billing(PK(user_id,provider), UNIQUE(provider,provider_customer_id))`; `subscriptions(… status CHECK in 6 values, UNIQUE(provider,provider_subscription_id), CHECK period_start<period_end)` + partial index `subscriptions_user_active_idx`; `entitlements(user_id PK, plan_code FK plans, period_*, jobs_used CHECK>=0, source_subscription_id FK)`; `usage_events(bigserial, user_id FK SET NULL, job_id FK **jobs** SET NULL, kind, detail jsonb)` + 2 indexes, **append-only** (`stemloops_app_insert`/`_select` policies, `GRANT SELECT,INSERT` only); `credit_purchases(… pack_code CHECK, credits_granted CHECK, amount_cad_cents, UNIQUE(provider,provider_charge_id), cross-column CHECK (pack_code,credits_granted) IN …)` append-only; `credit_consumption(user_id, job_id FK **jobs ON DELETE RESTRICT**, UNIQUE(job_id))` append-only; `promo_redemptions` append-only; `trial_grants(user_id PK, songs_used CHECK 0..3, expires_at default +7d)`. **`ALTER TABLE jobs ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL`** + partial index `jobs_user_id_idx`. Functions/triggers: `check_credit_decrement()` SECURITY DEFINER (rejects consumption unless `jobs.input_kind='upload'` and user matches) as `BEFORE INSERT OR UPDATE` trigger `credit_decrement_check`; `handle_new_user()` SECURITY DEFINER inserting `public.users` (null-email fallback `<id>@noemail.local`) + a `free` `entitlements` row, as `AFTER INSERT` trigger **`on_auth_user_created` on `auth.users`**; `touch_subscription_updated_at()` trigger. View `v_credit_balance WITH (security_invoker=true)` = purchases − consumption. Seeds minimal `plans('free')`. `REVOKE EXECUTE … FROM PUBLIC` on both SECURITY DEFINER functions. `cowork_ro_read` on the 10 tables if `cowork_ro` exists. | Yes **while the tables are empty**. Once users/ledger rows exist: no (dropping = data loss). | Yes. Drops triggers/functions/view, drops the 10 tables (**no CASCADE**, so it fails if 020/023/025 tables with FKs to `users`/`jobs` still exist — down those first), **`ALTER TABLE jobs DROP COLUMN user_id`** (data loss once populated). Does not drop `citext`, does not delete its ledger row. | **Brief write pause on `jobs`.** `ADD COLUMN` = `ACCESS EXCLUSIVE` on `jobs`; `CREATE INDEX jobs_user_id_idx` (non-concurrent) = `SHARE` on `jobs` (blocks writes while building); the two FKs into `jobs` = `SHARE ROW EXCLUSIVE` on `jobs`. **All held until the file's single transaction commits.** `CREATE TRIGGER ON auth.users` = `SHARE ROW EXCLUSIVE` on `auth.users` (blocks sign-ups momentarily — none exist yet). With `jobs` at 24 h retention this is seconds; still run at a quiet moment with `lock_timeout` (§5). | No | Requires PG ≥ 15 (`security_invoker`). `citext` installs into the current schema (`public`) — fine. **Trigger works [rehearsed]:** inserting into `auth.users` created the `public.users` row. **Existing `auth.users` rows are NOT backfilled** — the trigger is AFTER INSERT only (§4.4). |
| 014 | `014_v3_seed_plans.sql` | `INSERT … ON CONFLICT (code) DO UPDATE` for `free (0, 90, {youtube,spotify,soundcloud})`, `pro (499, 100000, {})`, `studio (1200, 100000, {})`. **Overwrites any admin edit** to those rows on every run (stated intent). ⟲ **SUPERSEDED 2026-11-11 by `034_v3_pricing_model_truth.sql`** — these values are no longer current; 014 is retained unedited as history. See the note below this table. | Yes (data). | Yes — `DELETE FROM plans WHERE code IN ('free','pro','studio')`: not a pure inverse (also removes 013's `free` seed) and **fails on FK** once any `entitlements` row exists (every sign-up creates one). | No | No | Depends on 013. |
| 015 | `015_v3_promo_redemptions_unique.sql` | `DELETE` duplicate `(user_id, stripe_promotion_code_id)` rows keeping lowest id (no-op on empty table); `DROP/ADD CONSTRAINT promo_redemptions_user_stripe_code_uniq UNIQUE (user_id, stripe_promotion_code_id)`. NULLs distinct. | Constraint yes; the dedupe DELETE has no inverse (irrelevant on prod — table is new/empty). | **No down file.** Reverse = `ALTER TABLE promo_redemptions DROP CONSTRAINT promo_redemptions_user_stripe_code_uniq`. | No | No | Depends on 013. Webhook `ON CONFLICT` target. |
| 016 | `016_v3_rename_price_cad.sql` | `DO` block renames `plans.price_usd_cents → price_cad_cents` **only if the old name exists** (it will not — 013 creates the new name) → effectively no-op; `COMMENT ON COLUMN`. | Yes (no-op). | Yes — **and it is harmful here**: it renames `price_cad_cents → price_usd_cents` unconditionally when the CAD name exists, i.e. it would break every query in the codebase. Never run it on a fresh-path DB. | No | No | Guarded for the already-applied (staging) case; prod takes the fresh path. |
| 017 | `017_v3_revoke_mutations_appendonly.sql` | `REVOKE UPDATE, DELETE ON usage_events, credit_purchases, credit_consumption, promo_redemptions FROM stemloops_app` — closes the hole that 011's default privileges re-granted at CREATE TABLE time. | Yes (re-grant) — **but do not**: the retention rewrite (#147) and `test_rate_limits.py` depend on append-only. | Yes (`GRANT UPDATE, DELETE` back). | No | No | Depends on 013. Verify with the grants query in §5 Phase 2 — this is the migration most likely to be "applied" yet ineffective if 011 ran as a different role than 013. |
| 018 | `018_v3_credit_purchases_cad.sql` | Guarded rename `credit_purchases.amount_usd_cents → amount_cad_cents` (no-op on prod); `COMMENT`. | Yes (no-op). | Yes — same hazard as 016's down: renames to `_usd_cents` and breaks the webhook. Never run. | No | No | |
| 019 | `019_v3_users_welcomed_at.sql` | `ALTER TABLE users ADD COLUMN IF NOT EXISTS welcomed_at timestamptz`; partial index `users_welcomed_at_null_idx ON users(id) WHERE welcomed_at IS NULL`; `COMMENT`. | Yes while NULL everywhere; dropping later loses "already welcomed" state → re-welcome spam (the exact bug it fixes). | Yes (drop index + column). | No | No | `dispatch.ts` tolerates a missing column by treating it as "send". |
| 020 | `020_v3_credit_packs_table.sql` | New table `credit_packs(pack_code PK CHECK in 3, credits CHECK in {20,60,180}, price_cad_cents CHECK>0, display_name, active)`; RLS; `credit_packs_public_read FOR SELECT TO anon,authenticated USING(active)`; `stemloops_app_all` + full CRUD grant; `cowork_ro_read` + `GRANT SELECT TO cowork_ro` if role exists; seeds `credits_20/500`, `credits_60/1200`, `credits_180/3000` with `ON CONFLICT DO UPDATE`; `COMMENT ON TABLE`. | Yes (catalog; re-seedable). | Yes (`DROP TABLE`). | No | No | Display-only prices; the charge is the Stripe `price_id` (§7 Stripe). `scripts/check_credit_pack_prices.py` cross-checks. |
| 021 | `021_v3_users_deleted_at.sql` | `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz`; partial index `users_deleted_at_idx WHERE deleted_at IS NOT NULL`; `COMMENT`. | Yes while NULL. Dropping later loses half-finished-deletion evidence. | Yes (drop index + column). | No | No | `users/me` route tolerates `42703` here. |
| 022 | `022_v3_credit_balance_clamp.sql` | `CREATE OR REPLACE VIEW v_credit_balance` = `GREATEST(0, purchases − consumption)`; re-`GRANT SELECT TO authenticated, stemloops_app`. | Yes. | Yes (restores 013 definition). **Order hazard:** if 023 is applied, running 022's down silently removes the `credit_adjustments` term too — down 023 first. | No | No | Header says "Dashboard paste required" — written expecting hand application. |
| 023 | `023_v3_credit_adjustments.sql` | New table `credit_adjustments(user_id FK CASCADE, credits_delta CHECK<>0, reason CHECK in {refund,manual_grant,adjustment}, provider, provider_event_id, provider_charge_id, UNIQUE(provider,provider_event_id))`; index `(user_id,created_at)`; **partial UNIQUE** `credit_adjustments_one_refund_per_charge_idx (provider,provider_charge_id) WHERE reason='refund'`; RLS; self-read; `stemloops_app_insert/_select`; `GRANT SELECT,INSERT` + explicit `REVOKE UPDATE, DELETE`; `cowork_ro_read` if role; **`CREATE OR REPLACE VIEW v_credit_balance`** = `GREATEST(0, purchases + SUM(credits_delta) − consumption)`. | Table: only while empty (it is the refund ledger). View: yes. | Yes — restores the 022 view and `DROP TABLE credit_adjustments` (ledger loss). No ledger-row delete. | No | No | **L17 canary [rehearsed]:** through the real runner the final view definition does contain `sum(credit_adjustments.credits_delta)` inside the `GREATEST`. Verify this on prod regardless of how you apply it (§5 Phase 3). |
| 024 | `024_v3_credit_adjustments_partial_refund_index.sql` | `DROP INDEX IF EXISTS credit_adjustments_one_refund_per_charge_idx`; `CREATE INDEX IF NOT EXISTS credit_adjustments_refund_charge_idx (provider,provider_charge_id) WHERE reason='refund'` (non-unique). | Yes until a charge has >1 partial-refund rows. | Yes — recreates the UNIQUE index; **fails** if any charge already has two refund rows. | No | No | Depends on 023. |
| 025 | `025_v3_chord_edits.sql` | New table `chord_edits(user_id FK users **no ON DELETE**, job_id FK **jobs no ON DELETE**, track_hash, provider, provider_version, start_sec/end_sec numeric(10,3), original_label, corrected_label, original_confidence real, cqt_plan_version, alphabet_sha; CHECKs valid_time_range, labels_differ, valid_harte '^(N\|X\|[A-G](#\|b)?(:[a-z0-9]+)?)$')`; indexes `(alphabet_sha, provider_version, created_at DESC)` and `(user_id, created_at)`; RLS; `authenticated` insert (WITH CHECK auth.uid()=user_id) + read-own policies (**dropped again by 027**); `stemloops_app_insert/_select`, `GRANT SELECT,INSERT`, **`REVOKE UPDATE, DELETE FROM stemloops_app`**; `cowork_ro_read` if role; `COMMENT`. | Only while empty (training data). | Yes (`DROP TABLE`). | No. FK into `jobs` = brief `SHARE ROW EXCLUSIVE` on `jobs` during the file's transaction. | No | **Consequences [rehearsed privilege]:** `relacl` shows `stemloops_app=ar` (SELECT, INSERT only). `DELETE /api/users/me` issues `DELETE FROM public.chord_edits` via the app connection → `permission denied` if that connection is `stemloops_app` (§4.3). Also: because neither FK cascades, the worker retention sweep cannot `DELETE` a job that has edits — the #147 rewrite anonymises instead (`cleanup.py::_anonymise_job`), which is why 017/025's append-only must stay. |
| 026 | `026_chord_edits_length_checks.sql` | `ALTER TABLE chord_edits ADD CONSTRAINT` ×9: `track_hash_len (=64)`, `alphabet_sha_len (=64)`, `provider_version_len (<=64)`, `cqt_plan_version_len`, `original_label_len (<=16)`, `corrected_label_len (<=16)`, `start_sec_range`, `end_sec_range (0..86400)`, `original_confidence_range (NULL or 0..1)`; 3 `COMMENT ON CONSTRAINT`. | Yes. | Yes — but the file is named **`down/026_chord_edits_length_checks.sql`** (no `_down` suffix; any `*_down.sql` glob misses it) **[rehearsed]**. Drops all 9 with `IF EXISTS`. | No | No | **Not idempotent**: plain `ADD CONSTRAINT` (no `IF NOT EXISTS`) — a second application errors `already exists`. Harmless under the runner (ledger skip), hazardous if you re-paste by hand. Depends on 025. |
| 027 | `027_v3_chord_edits_revoke_anon.sql` | `REVOKE ALL ON chord_edits FROM anon, authenticated`; `DROP POLICY IF EXISTS chord_edits_user_insert, chord_edits_user_read_own`. Closes the PostgREST direct-insert path. | Policies yes; the prior anon/authenticated grants (Supabase default privileges) are not recorded. | Yes — recreates the two policies, deliberately does **not** re-grant; `CREATE POLICY` without IF NOT EXISTS → errors if they exist. | No | No | Depends on 025. After it, the only writer is `stemloops_app` via `/api/chord-edits`. |
| 028 | `028_v3_klangio_usage.sql` | New table `klangio_usage(cycle_start date PK, count int CHECK>=0, updated_at)`; RLS; `stemloops_app_all`; `GRANT SELECT,INSERT,UPDATE TO stemloops_app`; **`REVOKE DELETE, TRUNCATE FROM stemloops_app`**; `REVOKE ALL FROM anon, authenticated`; `cowork_ro_read` if role; `COMMENT`. | Only while the counter is unimportant; dropping it resets the Klangio spend cap. | Yes (`DROP TABLE`) with a header warning. | No | No | Independent of 013. **Must precede the worker deploy** if `KLANGIO_API_KEY` is set and `DATABASE_URL` is set (`KLANGIO_QUOTA_BACKEND=auto` → Postgres store; missing table → `ChordProviderError`, fail-closed, chords lost). |
| 029 | `029_v3_chord_edits_harte_slash.sql` | `DROP CONSTRAINT IF EXISTS chord_edits_valid_harte`; `ADD CONSTRAINT chord_edits_valid_harte CHECK (corrected_label ~ '^(N\|X\|[A-G](#\|b)?(:(maj\|min\|…\|aug7))?(/[b#]*(10\|11\|12\|13\|[1-9]))?)$') NOT VALID`; `DO` block counts violators and `VALIDATE CONSTRAINT` only when zero, else `RAISE NOTICE` and leaves it NOT VALID. | Yes. | Yes — re-adds 025's regex **`NOT VALID`**: the one down that does not restore byte-for-byte. `pg_dump` diff vs. a forward-built 028 reference showed exactly that one difference (`convalidated t → f`) **[rehearsed]**. | No | No | On an empty table ends `convalidated = t` **[rehearsed]**. `RAISE NOTICE` output is **not shown** by the SQL editor — use the §5 Phase 4 query instead. Depends on 025 (and should follow 026/027). |
| 030 | `030_v3_jobs_klangio_job_id.sql` | **`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS klangio_job_id text`**; `COMMENT` (values: NULL / `'submitting'` sentinel / Klangio job id). | Yes while NULL. Dropping later discards the "already paid" record → a rerun re-bills $0.20. | Yes (`DROP COLUMN`) with header warning. | No. `ACCESS EXCLUSIVE` on `jobs` for a metadata-only ADD COLUMN — instant. | No | **Column before code is mandatory.** New worker code on the old schema: `pipeline.py` `_KlangioJobLedger` runs `SELECT klangio_job_id FROM jobs` → `UndefinedColumn` → caught by the blanket `except Exception` in `_run_chords` → `_write_chords_tombstone(job_id, "provider_failed")`. Jobs complete; every chord result is lost; one Sentry event per job. |

---

### 2.1 Addendum 2026-11-11 — migration 034 supersedes 014's plan values

This document covers 009–030 and its 014 row records what 014 does, which is
still accurate. But **014's VALUES are no longer the live catalog.**
`034_v3_pricing_model_truth.sql` applies after it and re-prices the plans on
*tracks converted to play-along*:

| code | tracks / month | price_cad_cents | `services` | `export_stems` | `export_wav24` |
|---|---|---|---|---|---|
| `free` | 5 (was 90) | 0 | `{youtube}` (was `{youtube,spotify,soundcloud}`) | false | false |
| `pro` | 50 (was 100000) | 499 | `{}` | false (was true) | false |
| `studio` | 150 (was 100000) | 1200 | `{}` | false (was true) | false (was true) |

Three operational notes for whoever runs the next cutover:

1. **034 is reversible and was tested both ways.** `down/034_v3_pricing_model_truth_down.sql`
   restores 014's exact values. It is an UPSERT, not a DELETE — unlike 014's own
   down file, which deletes the rows and therefore fails on the `entitlements`
   FK once any sign-up exists. Verified up → down → up against a Postgres 16
   instance carrying the full 001–034 chain applied by the real runner as the
   restricted `migrator` role.
2. **034 is pure DML plus three column COMMENTs.** No DDL, no new object, no
   lock of consequence, no RLS or GRANT change (013 created `plans` with both
   policies; 017's append-only REVOKE list does not include `plans`). The
   §3 irreversibility analysis below needs no new row.
3. ⚠️ **`scripts/check_migration_drift.py` will report production BEHIND as
   soon as 034 merges, and stay red until it is applied.** That is the gate
   working as designed — it exists because prod once sat on 008 while the code
   needed 031 — but it means merging 034 commits you to applying it.

---

## 3. Irreversibility analysis

Nothing in 009–030 destroys production data that exists today. Irreversibility is about (a) state that cannot be inferred back and (b) data that will accrue after cutover.

**Cannot be inferred back (no "before" snapshot exists in the repo):**
- **009/011/017/023/025/027/028 ACLs.** `REVOKE ALL … FROM PUBLIC` (009), `REVOKE ALL … FROM service_role` (011), `REVOKE UPDATE, DELETE … FROM stemloops_app` (017, 023, 025), `REVOKE ALL … FROM anon, authenticated` (027, 028), `REVOKE DELETE, TRUNCATE` (028). Postgres has no privilege history. The down files *guess*: 009's guess (`GRANT ALL TO PUBLIC`) is wrong and dangerous; 011's guess re-installs the known-wrong `service_role` model; 027's deliberately does not re-grant. **Mitigation:** capture `pg_policies`, `pg_tables.rowsecurity`, `pg_class.relacl` and `information_schema.role_table_grants` for `public` **before** Phase 1 (query P-3/P-4/P-5 in §7) and keep the output with the cutover log. That snapshot is the only true rollback reference for grants.
- **011 `ALTER DEFAULT PRIVILEGES`.** Role-scoped and forward-acting. Its down revokes the defaults but does not touch tables already created under them (017/023/025 exist precisely because of this).
- **015's dedupe `DELETE`.** No inverse; a no-op on prod because the table is new.
- **014's `ON CONFLICT DO UPDATE`.** Overwrites hand-edited plan prices; intended. Re-running after a manual price change reverts it.

**Reversible only while empty (becomes irreversible the moment real rows land):**
- 013 (`users`, `entitlements`, `credit_purchases`, `credit_consumption`, `promo_redemptions`, `subscriptions`, `customers_billing`, `usage_events`, `trial_grants`, `jobs.user_id`), 020 (`credit_packs` admin edits), 023 (`credit_adjustments` — refund ledger), 025 (`chord_edits` — training data), 028 (`klangio_usage` — spend counter), 030 (`jobs.klangio_job_id` — double-billing guard), 019/021 (`welcomed_at`, `deleted_at`).

**Down files that do not restore the prior state:**
| Down | Gap |
|---|---|
| `009_…_down` | `GRANT ALL ON <7 tables> TO PUBLIC` + `DISABLE RLS` — strictly worse than any plausible prior state. Do not run; use the hand statements in §6 Phase 1 instead. |
| `011_…_down` | Re-creates `service_role` policies, `REVOKE ALL FROM stemloops_app` → worker lockout if it connects as `stemloops_app`. |
| `013_…_down` | No `CASCADE` → fails while 020/023/025 exist; leaves `citext`; drops `jobs.user_id`; does not delete the ledger row. |
| `014_…_down` | Also deletes 013's `free` seed; FK-fails after any sign-up. |
| `016_…_down`, `018_…_down` | On a fresh-path DB these **rename the correct CAD columns to `_usd_cents`** and break the app. Never run on prod. |
| `022_…_down` | Correct only if 023 has not been applied (or has been downed first). |
| `024_…_down` | Recreates a UNIQUE index that fails once a charge has >1 partial refunds. |
| `027_…_down` | Recreates policies, not grants (by design). `CREATE POLICY` is not `IF NOT EXISTS`. |
| `029_…_down` | Leaves `chord_edits_valid_harte` **`NOT VALID`** where 025 had it validated **[rehearsed]**. Enforcement on new writes unchanged; old rows no longer certified. |
| All except 009/011 | **Do not delete their `_migrations` row** → next runner pass silently skips **[rehearsed]**. |

Staged rollback *does* work when done in reverse with ledger housekeeping: downs 030→023 applied in reverse produced a schema (grants included) identical to a forward-built 022 reference, and `v_credit_balance` reverted to its pre-adjustments definition **[rehearsed]**.

---

## 4. Ordering hazards and code coupling

### 4.1 Schema-internal ordering
```
009 ─┐
011 ─┴─ one transaction (see below)
012 ──→ 013 ──→ 014, 015, 016(no-op), 017, 018(no-op), 019, 020, 021
                 013 ──→ 022 ──→ 023 ──→ 024
                 013 ──→ 025 ──→ 026 ──→ 027 ──→ 029
028 (independent of 013; needs role stemloops_app, which prod has)
030 (independent; jobs only)
```
- **009 and 011 must commit together.** 011's header asserts prod *already* has `stemloops_app_all` policies out of band ("verified 2026-11-02"). If that is true, 009 alone is harmless. If it is **not** true and the worker connects as `stemloops_app` (not table owner, not BYPASSRLS), then the instant 009 commits RLS is on with no policy for `stemloops_app`: every worker `SELECT` returns zero rows and every `INSERT`/`UPDATE` fails — an outage that lasts until 011 commits. The runner closes that window to sub-second; a hand paste with a pause between files does not. **Paste 009 + 011 (+012) as one `BEGIN … COMMIT`.** They are idempotent and 011 supersedes 009 by design.
- 009's `REVOKE ALL … FROM PUBLIC` is only safe if the app role does not get its privileges *via* PUBLIC. Pre-flight query P-5 settles it.
- 026 is not idempotent; 027's down is not idempotent. Only matters if you hand-paste twice.

### 4.2 Code → schema seam (merged code that assumes 009–030)
| Code path | Needs | Reachable in prod today? | Failure if deployed before its migration |
|---|---|---|---|
| `POST /api/jobs` anonymous branch (`ANON_INSERT_SQL`, upload branch without `user`) | 001–008 only | **Yes — the core product** | None from schema. **Fails from env**: `getUser()` → `readPublicEnv()` throws without `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` → outer catch → `500 INTERNAL_ERROR` on every job creation. |
| `POST /api/jobs` authed branches (`enforceEntitlement`, `checkBurstLimit`, `consumeCreditInTx`, `consumeTrialInTx`, `INSERT … user_id`) | 013 (+014, 017) | Only once Supabase env is set and someone signs in | `relation "entitlements" does not exist` → 500 for signed-in users only. |
| `GET /api/jobs/[id]`, `/play-chords`, worker `consumer.py`/`pipeline.py` loops + job_events inserts, `reaper.py` | 001–008 | Yes | None — verified column lists match 001–008 (`loops` 15 cols, `job_events` 5 cols, stages `downloading/separating/extracting/uploading`). |
| Worker `cleanup.py` retention (#147) | 001–008; tolerates FK violations from 013/025 | Yes | None on either schema. On the new schema it anonymises ledger-bound jobs instead of deleting. |
| Worker chord stage `_KlangioJobLedger` (#149) | **030** | Yes if `CHORDS_PROVIDER` ≠ '' (default `klangio`) | Every chord attempt → silent `provider_failed` tombstone + Sentry noise. **Also** without `KLANGIO_API_KEY` in Fly secrets the same tombstone fires for a different reason (`ChordProviderError`). Decide: set the key, or set `CHORDS_PROVIDER=''`. |
| Worker `_PostgresQuotaStore` (#125) | **028** | Yes when `DATABASE_URL` set (auto backend) | `ChordProviderError` fail-closed; chords lost. |
| `/pricing` page | 013, 020 | Yes (anonymous) | Degrades to `FALLBACK` constants with a banner; logs error. Not fatal. |
| Stripe webhook `/api/billing/webhook` | 013, 015, 019, 022–024 | Only if a Stripe endpoint is registered for prod | `relation … does not exist` → non-2xx → Stripe retries. |
| `DELETE /api/users/me` | 013, 021 (tolerant), 025 (tolerant of **absence**, not of **permission denied**) | Only authed | See §4.3. |
| `POST /api/users/me/claim-jobs` (`UPDATE jobs SET user_id`) | 013 | Only authed | 500. |
| `handle_new_user` trigger | — | n/a | Fires only for `auth.users` rows inserted **after** 013 (§4.4). |

**Conclusion:** the anonymous product does not care about 009–030 at all. The schema seam bites only (a) the worker chord stage (028/030 → worker deploy order) and (b) any signed-in user (013 → web deploy with Supabase env). The env seam (`NEXT_PUBLIC_SUPABASE_*`) bites **everyone**.

### 4.3 Account deletion vs. append-only `chord_edits` (blocking pre-flight item)
`apps/web/src/app/api/users/me/route.ts:145` runs `DELETE FROM public.chord_edits WHERE user_id = $1::uuid` on the app pool (`DATABASE_URL_POOLED ?? DATABASE_URL`) and swallows only `42P01` (undefined_table). 025 leaves `stemloops_app` with `SELECT, INSERT` only (`relacl … stemloops_app=ar/postgres`; `has_table_privilege(… 'DELETE') = f`) **[rehearsed]**. Postgres checks table privilege before touching rows, so **even a zero-row delete raises `42501 permission denied`**, which the route re-throws — *after* step 2 has cancelled the user's Stripe subscription and step 3 has stamped `deleted_at`. Net: the user is cancelled and tombstoned but not deleted, and gets a 500.

- **If the web app connects as `postgres`** (owner, BYPASSRLS): no problem — the REVOKE does not apply to the owner.
- **If it connects as `stemloops_app`**: account deletion is broken from the moment 025 lands and the web deploys. Remedies (pick one, in a new migration, not by editing 025):
  1. `GRANT DELETE ON public.chord_edits TO stemloops_app;` — simplest; weakens append-only for this one table (the comment in 025 §"Account-delete sweep" implies the sweep was always meant to be the one sanctioned delete path).
  2. A `SECURITY DEFINER` function owned by `postgres`, e.g. `public.sweep_chord_edits_for_user(uuid)`, `REVOKE EXECUTE FROM PUBLIC`, `GRANT EXECUTE TO stemloops_app`; route calls `SELECT public.sweep_chord_edits_for_user($1)`. Keeps the table append-only for the role.
- Also note the same FK (`chord_edits.user_id` no `ON DELETE`) means `auth.admin.deleteUser` itself fails with an FK violation if any edits survive the sweep — so the sweep is load-bearing, not cosmetic.
- **Pre-flight P-6** determines the role. If `stemloops_app`, do not deploy the web app until the remedy migration (`031_…`) exists and is applied in Phase 4.

### 4.4 Pre-existing `auth.users` rows
`on_auth_user_created` is `AFTER INSERT`. Any `auth.users` row that exists before 013 (e.g. a test account someone created in the prod Supabase Auth UI) will never get a `public.users`/`entitlements` row; that user can sign in but every entitlement lookup 500s. Pre-flight P-8 counts them. If `> 0`, run the backfill in §5 Phase 2 step 2.6.

### 4.5 Deploy-order summary
1. Phases 1–5 (all 21 migrations) → verify.
2. **Worker** (Fly) deploy — only after 028 + 030; needs the `klangio_quota` volume to exist first (`fly.toml [mounts]`; Fly refuses to start the Machine otherwise) and a decision on `KLANGIO_API_KEY` vs `CHORDS_PROVIDER=''`.
3. **Web** (Vercel) deploy — only after 013–024 and the §4.3 decision; needs `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` set in Production **before** the deploy is promoted; `SUPABASE_SERVICE_ROLE_KEY` for deletion; hCaptcha pair for sign-up; Stripe per §7.
4. Old code on new schema is safe in both directions (all new columns nullable and unused by old code; old worker's `DELETE FROM jobs` would FK-fail only for ledger-bound jobs, which cannot exist until authed users act).

### 4.6 Where the static read and the rehearsal disagree
- **L17 in the SQL editor.** The rehearsal note infers that pasting 023 into the Supabase SQL editor "in one go" would reproduce L17 (statements after a `DO $$` block silently dropped). My static read disagrees: L17 was a **psycopg driver-path** defect (whole file handed to one `conn.execute()`), per `migrate.py`'s own docstring; the Dashboard SQL editor goes through pg-meta/node-postgres with the simple-query protocol, which executes a multi-statement string in full, and 022's header ("Dashboard paste required") plus the project's staging bundles were written on that assumption. **Neither side has tested it on Supabase.** The plan therefore does not rely on either view: every phase ends with a verification query that would expose a dropped statement, and Phase 3 specifically asserts the view text contains `credit_adjustments`. If the Phase 3 check fails, re-paste the single `CREATE OR REPLACE VIEW` statement from 023 by itself.
- Everything else in the rehearsal (role chain, trigger, 029 `convalidated`, 026 filename, ledger-not-maintained-by-downs, 29-row count, idempotency) matches the static read.
- The rehearsal proves the SQL chain on bare Postgres; it **cannot** show Supabase-specific behaviour: `stemloops_app` already exists as LOGIN with out-of-band grants/policies; `postgres` is not superuser; `auth` schema permissions (§2, row 012); PostgREST exposure of new tables via `anon`/`authenticated` default privileges. Those are pre-flight reads (§7), not assumptions.

---

## 5. Ordered runbook

### 5.1 Choose the application path
- **Path A — Supabase Dashboard SQL editor (recommended given no `psql`).** Project `qthrhamfljhifhfwvvwj` → SQL Editor → new query. Runs as `postgres`. Each step below is one paste. Wrap exactly as shown so atomicity does not depend on the editor's behaviour. `RAISE NOTICE` output is not displayed — rely on the verification queries. The same SQL can go through the Supabase connector's `execute_sql`. **Do not use the connector's `apply_migration`**: it records into `supabase_migrations.schema_migrations`, not `public._migrations`, and the repo runner would then try to re-apply everything.
- **Path B — repo runner.** `cd apps/worker && DATABASE_URL='postgresql://postgres:…@…:5432/postgres' python -m src.worker.migrate` (needs Python 3.11+, `pip install -r requirements.txt -c constraints-prod.txt`). Use the **session** connection string (direct `db.<ref>.supabase.co:5432` is IPv6-only without the IPv4 add-on; the pooler's port 5432 session mode works). Runs all 21 files in order, one transaction each, stops at first error. You lose the ability to pause between phases unless you temporarily move later files out of the directory — do not; instead run it once and then run every verification query in §5 afterwards.

Both paths must run as the **same role** throughout (default privileges in 011 are role-scoped). Use `postgres`.

### 5.2 Paste template (Path A)
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';          -- fail fast instead of queueing behind a long tx
SET LOCAL statement_timeout = '120s';
-- <paste the entire contents of the migration file here, unmodified>
INSERT INTO public._migrations(filename) VALUES ('<exact filename>.sql');
COMMIT;
```
If it errors, the whole paste rolled back; fix the cause and re-paste. If `lock_timeout` fires (`canceling statement due to lock timeout`), the worker was mid-transaction — just retry.

### 5.3 Phases

**Phase 0 — Pre-flight.** Complete §7 and record every output. Do not continue with an open blocking item.

**Phase 1 — Roles and RLS catch-up (009 + 011 + 012, one transaction).**
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
-- paste 009_rls_catchup.sql
-- paste 011_role_catchup.sql
-- paste 012_v3_supabase_stubs.sql
INSERT INTO public._migrations(filename) VALUES
  ('009_rls_catchup.sql'), ('011_role_catchup.sql'), ('012_v3_supabase_stubs.sql');
COMMIT;
```
Verify:
```sql
SELECT tablename, rowsecurity FROM pg_tables
 WHERE schemaname='public' AND tablename IN
 ('jobs','job_events','loops','upload_rate_events','kill_switches','blocklist','fetch_attempts')
 ORDER BY 1;                                   -- 7 rows, rowsecurity = true
SELECT tablename, policyname, roles FROM pg_policies WHERE schemaname='public' ORDER BY 1,2;
  -- stemloops_app_all on all 7; NO '%_service_role_all'; cowork_ro_read on every table iff cowork_ro exists
SELECT filename FROM public._migrations ORDER BY filename;   -- ends 008, 009, 011, 012
SELECT status, count(*) FROM jobs WHERE updated_at > now() - interval '15 minutes' GROUP BY 1;
```
**Stop and check:** submit one anonymous upload on stem-loops.com and watch it reach `done`. If the worker stalls (no `updated_at` movement) the app role lost access — go to §6 Phase 1.

**Phase 2 — Commercial core (013 → 021).** One paste per file, in order: 013, 014, 015, 016, 017, 018, 019, 020, 021. Run 013 at a quiet moment (it holds `jobs` write locks for its transaction).
Verify after 021:
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1;
  -- + users, plans, customers_billing, subscriptions, entitlements, usage_events,
  --   credit_purchases, credit_consumption, promo_redemptions, trial_grants, credit_packs
SELECT code, price_cad_cents, monthly_job_quota, services FROM public.plans ORDER BY 1;
  -- 014's values: free 0/90/{youtube,spotify,soundcloud}; pro 499/100000/{}; studio 1200/100000/{}
  -- SUPERSEDED by 034: free 0/5/{youtube}; pro 499/50/{}; studio 1200/150/{}; all export flags false
SELECT pack_code, credits, price_cad_cents FROM public.credit_packs ORDER BY 2;  -- 20/500 60/1200 180/3000
SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgname IN
 ('on_auth_user_created','credit_decrement_check','subscriptions_touch_updated_at');  -- 3 rows
SELECT column_name FROM information_schema.columns
 WHERE table_name='jobs' AND column_name='user_id';                                 -- 1 row
SELECT column_name FROM information_schema.columns
 WHERE table_name='users' AND column_name IN ('welcomed_at','deleted_at');          -- 2 rows
SELECT conname FROM pg_constraint
 WHERE conrelid='public.promo_redemptions'::regclass
   AND conname='promo_redemptions_user_stripe_code_uniq';                           -- 1 row
-- 017 effectiveness (the one most likely to be "applied" yet moot):
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
 WHERE table_schema='public' AND grantee='stemloops_app'
   AND table_name IN ('usage_events','credit_purchases','credit_consumption','promo_redemptions')
 GROUP BY 1;                                   -- each exactly INSERT,SELECT
SELECT (SELECT count(*) FROM auth.users) AS auth_users, (SELECT count(*) FROM public.users) AS public_users;
```
Step 2.6 — **only if `auth_users > public_users`** (pre-existing auth rows, §4.4):
```sql
BEGIN;
INSERT INTO public.users (id, email)
  SELECT id, COALESCE(email, id::text || '@noemail.local') FROM auth.users
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.entitlements (user_id, plan_code, period_start, period_end)
  SELECT id, 'free', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month'
    FROM auth.users
  ON CONFLICT (user_id) DO NOTHING;
COMMIT;
```
Re-run the last count query; the two numbers must match.

**Phase 3 — Credit ledger (022 → 024).** One paste each: 022, 023, 024.
Verify:
```sql
SELECT pg_get_viewdef('public.v_credit_balance'::regclass, true);
  -- MUST contain both GREATEST( and credit_adjustments  (L17 canary)
SELECT indexname FROM pg_indexes WHERE tablename='credit_adjustments' ORDER BY 1;
  -- credit_adjustments_pkey, credit_adjustments_provider_provider_event_id_key,
  -- credit_adjustments_refund_charge_idx, credit_adjustments_user_idx;
  -- and NOT credit_adjustments_one_refund_per_charge_idx
SELECT string_agg(privilege_type, ',' ORDER BY 1) FROM information_schema.role_table_grants
 WHERE table_name='credit_adjustments' AND grantee='stemloops_app';   -- INSERT,SELECT
```

**Phase 4 — Chord edits (025 → 027, 029).** One paste each, in order: 025, 026, 027, 029. (If §4.3 resolved to "stemloops_app", apply the remedy migration `031_…` here as well.)
Verify:
```sql
SELECT conname, convalidated FROM pg_constraint
 WHERE conrelid='public.chord_edits'::regclass AND contype='c' ORDER BY 1;
  -- 12 rows, all convalidated = true; chord_edits_valid_harte present
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='chord_edits_valid_harte';
  -- contains 'maj|min|dim' and '(/[b#]*'
SELECT policyname, roles FROM pg_policies WHERE tablename='chord_edits' ORDER BY 1;
  -- stemloops_app_insert, stemloops_app_select (+ cowork_ro_read iff role); none for {authenticated}
SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name='chord_edits' AND grantee IN ('anon','authenticated');          -- 0 rows
SELECT has_table_privilege('stemloops_app','public.chord_edits','DELETE');        -- f (or t if 031 chose GRANT)
```

**Phase 5 — Klangio (028, 030).** One paste each.
Verify:
```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name='jobs' AND column_name='klangio_job_id';                         -- 1 row
SELECT string_agg(privilege_type, ',' ORDER BY 1) FROM information_schema.role_table_grants
 WHERE table_name='klangio_usage' AND grantee='stemloops_app';                     -- INSERT,SELECT,UPDATE
SELECT count(*) FROM public._migrations;                                           -- 30 (see §9.1)
SELECT filename FROM public._migrations ORDER BY filename;                         -- 001..009, 011..030
```
**30 is complete** (001–009, 011–031). There is no `010_*.sql`. **29 means 031 was missed**, and 031 is mandatory — see §9.1 and §9.3.

**Phase 6 — Worker deploy (Fly app `stem-loops`).**
1. Fly dashboard → Volumes: confirm `klangio_quota` (1 GB, `iad`) exists. If not, create it (dashboard) — the new `fly.toml` mounts it and the Machine will not start without it.
2. Secrets: decide `KLANGIO_API_KEY` (set) **or** `CHORDS_PROVIDER=''` (disable chords). Leaving both unset = one Sentry event per job.
3. GitHub → Actions → "Deploy" → `workflow_dispatch`, target `worker`, ref `v3/main`. (Deploys are manual-only; nothing auto-deploys on merge.)
4. Verify: one anonymous upload reaches `done`; `SELECT klangio_job_id FROM jobs ORDER BY created_at DESC LIMIT 3` shows an id or NULL (never stuck at `'submitting'` after the job is done); if chords enabled, `SELECT * FROM klangio_usage` has one row for the current cycle.

**Phase 7 — Web deploy (Vercel project `stem-loops-web`).**
1. Production env (Vercel → Settings → Environment Variables → Production): **required before promote** — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (prod project's); `SUPABASE_SERVICE_ROLE_KEY`; `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` + `HCAPTCHA_SECRET_KEY` (site registered for `stem-loops.com`, else sign-up shows "Bot check unavailable"); `RESEND_API_KEY` (+`RESEND_FROM`) or emails are skipped with a warn. Stripe: **see §7 — either none of the Stripe vars, or all of them in live mode. Never a sandbox key in production.**
2. Supabase Auth settings on the prod project (dashboard, not in repo): Site URL `https://stem-loops.com`, redirect URLs, email templates, OAuth providers. Unknowable from the repo — operator item.
3. GitHub Actions "Deploy", target `web`, ref `v3/main`.
4. Verify: anonymous upload end-to-end (the only thing production users do today); `/pricing` renders without the "temporarily unavailable" banner; sign up a throwaway account → `SELECT count(*) FROM public.users` and `entitlements` increment by one, `plan_code='free'`; `GET /api/entitlements` returns `free`; delete the account via the UI → both rows gone (this exercises §4.3). `scripts/smoke_staging.mjs` can be pointed at prod (`STAGING_BASE_URL=https://stem-loops.com`, prod `SUPABASE_URL`/keys) but **its steps 7–8 create real Stripe customers/sessions** — only run it with billing disabled or deliberately in live mode.

**Phase 8 — Billing enablement.** A separate go/no-go. Not part of this cutover.

---

## 6. Rollback plan per phase

General rule for any rollback that uses a down file: **finish with `DELETE FROM public._migrations WHERE filename = '<file>';`** or the next runner pass skips it silently **[rehearsed]**. Only `009_…_down` and `011_…_down` do this themselves.

| After phase | What is recoverable | How | What is not |
|---|---|---|---|
| **1** (009/011/012) | Everything — only policies/grants changed. | **Do not run `009_…_down`** (GRANT ALL TO PUBLIC). If the worker is locked out, the fastest fix is forward: ensure `stemloops_app_all` exists on all 7 tables (re-paste the Phase 1 bundle — idempotent). To truly revert, restore the ACL/policy snapshot from P-3/P-4/P-5 by hand (`DROP POLICY …; ALTER TABLE … DISABLE ROW LEVEL SECURITY` only if P-3 showed RLS was off; re-`GRANT` exactly what P-5 listed), then `DELETE FROM _migrations WHERE filename IN ('009…','011…','012…')`. | Nothing, provided the P-3/P-5 snapshot was taken. Without it, the exact prior grants are gone. |
| **2–5** (013–030), **no user rows yet** | Everything. The tables are empty; the two `jobs` columns are all NULL. | Reverse order: `030_…_down`, `028_…_down`, `029_…_down`, `027_…_down`, `026` down, `025_…_down`, `024_…_down`, `023_…_down`, `022_…_down`, `021_…_down`, `020_…_down`, `019_…_down`, `017_…_down` (optional — 013 down removes the tables anyway), `015` by hand (`DROP CONSTRAINT`), `014_…_down`, `013_…_down`. **Skip 016/018 downs** (they would corrupt the schema). Then `DELETE FROM _migrations WHERE filename >= '013'` (exact list). Verify `SELECT count(*) FROM _migrations` = 11 (001–009, 011, 012). | `citext` extension remains (harmless). Grants revoked by 017/023/025/027/028 vanish with their tables. |
| **2–5, after the first real sign-up / purchase / chord edit** | **Code only.** The schema is additive and old code ignores it. | Vercel: promote the previous production deployment (restore doc: `dpl_CbpmufrEWUtc6t9esMf7psrc5e3t` is the pre-V3 one; Vercel keeps old deployments 30 days / newest 10). Fly: deploy the previous image (restore doc names v23). Leave every table in place. | **Point of no return for the schema.** `users`, `entitlements`, `credit_purchases`, `credit_consumption`, `credit_adjustments`, `chord_edits`, `klangio_usage`, `jobs.user_id`, `jobs.klangio_job_id` now hold money/consent/training/billing-guard state with no other copy. Do not drop; do not relax append-only. |
| **6** (worker deploy) | Fully — old worker on new schema is safe (new columns nullable; FK-bound jobs only exist after authed use, and the old sweep would merely log a DB error and retry those). | Fly → previous release/image. If 030 is downed **after** the new worker is live, in-flight jobs re-bill Klangio; down the code first, then the column. | Klangio spend already incurred. |
| **7** (web deploy) | Fully — promote previous Vercel deployment. Env vars can stay. | Vercel dashboard. | Any sign-ups that happened in between (they are real users now). |

**Named point of no return:** the first row in `public.users` created by a real person (or the first `credit_purchases` row under a live Stripe key). Everything before it is a schema exercise that can be fully unwound in minutes; everything after it is a product with customers.

---

## 7. Pre-flight checklist

Run every query read-only in the prod SQL editor and save the output with the cutover log. Items marked **BLOCKING** stop the cutover until answered.

**P-1 Backup.** Supabase → Database → Backups: confirm a daily backup exists dated today and note whether PITR is enabled on the plan (dashboard shows it; the repo cannot). If neither, the 24 h-ephemeral nature of prod data makes this acceptable for Phases 1–5 but **not** for Phase 7 onward. Record the decision.

**P-2 Ledger and version.**
```sql
SELECT filename, applied_at FROM public._migrations ORDER BY filename;   -- exactly 001..008
SHOW server_version;                                                      -- must be >= 15 (security_invoker)
SELECT extname FROM pg_extension WHERE extname='citext';                  -- 0 rows is fine (013 creates it)
```

**P-3 RLS / owner state of the hot tables.**
```sql
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY 1;
```
Owner should be the role you will run migrations as (`postgres`). If any table is owned by another role, `ALTER TABLE` in 013/030 fails — **BLOCKING** until resolved.

**P-4 Existing policies (011's header claims `stemloops_app_all` already exists on all 8).**
```sql
SELECT tablename, policyname, roles, cmd FROM pg_policies WHERE schemaname='public' ORDER BY 1,2;
```
If `stemloops_app_all` is absent on any of the 7 and P-6 says the worker is `stemloops_app`, Phase 1 **must** be the single-transaction bundle (it is anyway).

**P-5 Current grants (the rollback reference for every REVOKE).**
```sql
SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants WHERE table_schema='public' GROUP BY 1,2 ORDER BY 2,1;
SELECT relname, relacl FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1;
```
If `PUBLIC` appears as a grantee on any of the 7 tables, 009's `REVOKE ALL FROM PUBLIC` removes the app's access — **BLOCKING**; grant the app role directly first.

**P-6 Which role do the apps connect as? — BLOCKING (§4.3).**
```sql
SELECT usename, application_name, client_addr, count(*)
  FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1,2,3 ORDER BY 4 DESC;
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole
  FROM pg_roles WHERE rolname IN ('postgres','stemloops_app','cowork_ro','service_role','anon','authenticated','authenticator');
```
Cross-check with the username in the Vercel `DATABASE_URL`/`DATABASE_URL_POOLED` and Fly `DATABASE_URL` secrets (read the user part only). If the **web** app is `stemloops_app` → account deletion breaks after 025; write and include the `031` remedy before Phase 7. If the **worker** is `stemloops_app` and is **not** `rolbypassrls` → Phase 1 bundling is mandatory and P-4 matters.

**P-7 Hot-table size (lock duration for 013).**
```sql
SELECT (SELECT count(*) FROM jobs) jobs, (SELECT count(*) FROM loops) loops, (SELECT count(*) FROM job_events) job_events;
```
Thousands = seconds of write pause; no maintenance window. If unexpectedly large (retention sweep broken), fix that first.

**P-8 Pre-existing auth users (§4.4).**
```sql
SELECT count(*) FROM auth.users;
SELECT tgname FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal;  -- expect none named on_auth_user_created
```

**P-9 Nothing of 013+ already exists out of band.**
```sql
SELECT to_regclass('public.users'), to_regclass('public.plans'), to_regclass('public.chord_edits'),
       to_regclass('public.klangio_usage'), to_regclass('public.v_credit_balance');   -- all NULL
```
Any non-NULL means someone hand-applied part of V3 to prod; stop and reconcile before running the runner (it has no checksum and `IF NOT EXISTS` will paper over drift).

**P-10 `auth` schema privilege for 012 (§2 row 012).** On the rehearsal copy only; if 012 fails with `permission denied for schema auth` on Supabase, record 012 in `_migrations` without executing it and log the deviation.

**P-11 Deploy state.** Vercel `stem-loops-web` current production deployment id and commit (expect `dpl_CbpmufrEWUtc6t9esMf7psrc5e3t` / `c3f6a911` if nothing has shipped since 2026-11-02 — verify, do not assume). Fly `stem-loops` current release (expect v23). Confirm no GitHub "Deploy" workflow run is in progress. Confirm the Fly volume `klangio_quota` exists or plan to create it.

**P-12 Env vars present in Vercel Production before Phase 7.** Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_HCAPTCHA_SITE_KEY`, `HCAPTCHA_SECRET_KEY`. Recommended: `RESEND_API_KEY`, `RESEND_FROM`. Existing (keep): `DATABASE_URL`, `DATABASE_URL_POOLED`, `IP_HASH_KEY`, `HISTORY_COOKIE_KEY`, `R2_*`, `SENTRY_*`, `ALLOW_YOUTUBE_INPUT`, `NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT`. Fly before Phase 6: existing secrets plus a decision on `KLANGIO_API_KEY` / `CHORDS_PROVIDER`.

**P-13 Stripe live mode — not flipped.** `apps/web/src/lib/billing/providers/stripe.ts` falls back to **sandbox** price ids (`price_1UXm…`) whenever `STRIPE_PRICE_CREDITS_{20,60,180}`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_STUDIO_MONTHLY` are unset. Consequences:
- `STRIPE_SECRET_KEY` **unset** in prod → `/api/billing/checkout` and the webhook throw a clear error (500); `/pricing` still renders; nobody can buy. **This is the safe state for this cutover.**
- A **live** `STRIPE_SECRET_KEY` with price vars unset → "No such price" on every checkout.
- A **sandbox** `STRIPE_SECRET_KEY` in prod → anyone can "buy" credits with test card `4242…` and receive real entitlements. **Never.**
Flipping live later needs, together: live restricted key, live webhook endpoint `https://stem-loops.com/api/billing/webhook` + `STRIPE_WEBHOOK_SECRET`, all five live price ids, and `make check-prices` (`SOURCE=db`) green.

**P-14 Rehearsal done.** The plan has been executed end-to-end on a throwaway copy that mirrors prod: a fresh Supabase project with 001–008 pasted, roles `stemloops_app` (LOGIN) and `cowork_ro` created as on prod, then Phases 1–5 exactly as written (**Path A**, since that is what prod will use — the local Postgres rehearsal covered Path B). Staging (`ylzokjwnsraehmpclnkx`) is **not** a valid rehearsal target: it has no `_migrations`, lacks `chord_edits`/`klangio_usage`, and its true applied set is unknowable.

---

## 8. Things this document could not determine from the repo (operator must verify)

1. Which Postgres role the web app and the worker connect as in production (P-6). Decides §4.3 and the Phase 1 hazard.
2. Current prod RLS flags, policies and grants on the 8 existing tables (P-3/P-4/P-5). 011's header asserts a state nobody has re-read since 2026-11-02.
3. Whether `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` already exist in Vercel Production (P-12). If not, the first web deploy takes the product down.
4. Whether `auth.users` on prod has any rows (P-8).
5. Prod Postgres major version (P-2) — 013 needs ≥ 15.
6. Backup/PITR status on the plan (P-1).
7. Whether `postgres` on this Supabase project may `CREATE TABLE IF NOT EXISTS` in `auth` (P-10) — only the rehearsal copy can tell.
8. Whether the Fly volume `klangio_quota` exists (P-11).
9. Current Vercel production deployment and Fly release ids (P-11) — the restore doc's values are from 2026-11-02 and may be stale.
10. Supabase Auth configuration (site URL, redirect URLs, providers, email templates) for the prod project — entirely outside the repo.
11. Whether the Supabase SQL editor executes a multi-statement paste atomically and completely (§4.6). The `BEGIN/COMMIT` wrapper and per-phase verification queries make the plan correct either way.


---

## 9. Post-rehearsal corrections — 2026-11-06

The plan was rehearsed end to end against a throwaway Supabase project created to mirror prod
(baseline parity confirmed on 9 checks: ledger at 008, RLS on all 8 tables, `stemloops_app_all`
policies present, `stemloops_app` without BYPASSRLS, no `cowork_ro`, `PUBLIC` not a grantee).
Migrations 009→031 were then applied in the runner's lexical order and verified.

**Everything in this section is [rehearsed] unless marked otherwise. Where it conflicts with
§§0–8, this section wins.**

### 9.1 The ledger target is 30, not 29

§5 Phase 5 said 29 and warned that 30 "would mean something extra was recorded". That was written
for 009→030. Migration **031 exists on `origin/v3/main` and is mandatory** (§9.3), so the correct
post-cutover count is **30**. Verifying against 29 would read as a failure, or worse, as success
with 031 missing.

### 9.2 Migration 012 fails on Supabase — fixed

`CREATE TABLE IF NOT EXISTS auth.users` performs the schema CREATE-privilege check **before** the
IF-NOT-EXISTS short-circuit. On Supabase `postgres` does **not** hold CREATE on `auth`
(`has_schema_privilege('postgres','auth','CREATE')` = false, confirmed on prod and on the replica),
so 012 raises:

    ERROR: 42501: permission denied for schema auth

Through the runner this halts at 012 and leaves 013–031 unapplied. The local-Postgres rehearsal
could not surface it, because bare Postgres has no `auth` schema. AGENTS.md M-3 anticipated this class.

**Fixed and merged.** PR #157 wraps the create in a `DO` block guarded by a `pg_class` existence
check. Watched to fail before the fix and to pass as a no-op after, against a real Supabase project.
This removes the manual deviation §2 documented (record 012 without running it), so the runner now
completes 009→031 end to end with no human intervention.

**Consequence for §5.1:** the sanctioned deviation for 012 no longer applies. Do not record 012
without running it — run it.

### 9.3 031 is mandatory before Phase 7, not optional

Pre-flight P-6 resolved against us: the app connects as **`stemloops_app`**, which does not hold
BYPASSRLS. After 025 that role has SELECT/INSERT only on `chord_edits`, and Postgres checks table
privilege before touching rows — so even a zero-row delete raises `42501`, **after** the Stripe
cancel and the `deleted_at` stamp.

Both halves were tested on the replica:

| Action, as `stemloops_app` | Result |
|---|---|
| `DELETE FROM public.chord_edits WHERE user_id = ...` | `ERROR: 42501: permission denied for table chord_edits` |
| `SELECT public.delete_chord_edits_for_user(...)` | returned `1` — row erased |

031 is the remedy and it works. Do not deploy the web app without it.

*Caveat:* `pg_stat_activity` proves the connected role is `stemloops_app`; it cannot distinguish the
web app from the worker if they share a credential. The conclusion holds either way. To make it
Direct, read the username portion of the Vercel `DATABASE_URL_POOLED` and the Fly `DATABASE_URL`.

### 9.4 Two hazards §4.1 worried about do not exist on prod

- **RLS is already enabled** on all 8 tables, and the **`stemloops_app_all` policy already exists**
  on all 8 — 011's header claim from 2026-11-02, re-verified 2026-11-06. 009 also never touches
  `stemloops_app` grants or policies (it revokes only from `PUBLIC`, grants only to `service_role`).
  So the "009 commits, RLS on with no policy, worker locked out until 011" window **cannot occur**.
  Bundling 009+011+012 is still harmless, but it is no longer load-bearing — which matters because
  the repo runner uses **one transaction per file** and never bundles.
- **`PUBLIC` is not a grantee** on any of the 8 tables, so 009's `REVOKE ALL ... FROM PUBLIC`
  removes nothing the app relies on. P-5's BLOCKING condition is not triggered.

### 9.5 Things the verification queries will show that are NOT failures

- **`cowork_ro` does not exist on prod.** Every `cowork_ro_read` policy branch in 011/013/020/023/025/028
  is guarded and will skip. Their absence is correct, not a failed migration.
- **`anon` and `authenticated` hold ALL privileges (`arwdDxtm`) on all 8 tables.** This is Supabase's
  **default** for tables created by `postgres` in `public` — reproduced identically on a brand-new
  project — not a misconfiguration. RLS is what gates them, and neither role has BYPASSRLS. 009
  revokes from `PUBLIC` but not from these two, so it survives the cutover. Latent, not urgent:
  one disabled RLS flag away from anonymous write access.
- **001–008 contain zero RLS, role, policy or grant statements** (all eight grepped). Prod's entire
  grant posture was applied out of band and exists nowhere in version control. That is a class-6
  seam in its own right.

### 9.6 Notes on execution path

- `execute_sql` through the Supabase connector runs a multi-statement string **atomically** — a probe
  that errored mid-string rolled back the whole thing, and statements after a row-returning `SELECT`
  **do** still execute (both tested). This does not settle §4.6, which is about the **Dashboard SQL
  editor**, a different surface that remains untested.
- The connector's destructive-statement gate **did not fire once** across all 30 migrations, including
  009's REVOKEs and 029's DROP CONSTRAINT. The session-8 claim that it "blocks migration 009" is not
  reproducible.
- `postgres` holds TRIGGER privilege on `auth.users` even though `supabase_auth_admin` owns it, so
  013's `on_auth_user_created` trigger creates cleanly. Verified by inserting a real `auth.users` row:
  `public.users` and a `free` entitlement were both created by the trigger.
