-- 041_v3_migrations_ledger_rls_down.sql — deliberately does nothing. Run by hand only.
--
-- Reversing 041 means re-opening public._migrations to the anon (public) key, which is the
-- vulnerability 041 closes (QA track B, B-01). There is no state 041 creates that needs
-- removing: no policy, no column, no grant was added.
--
-- The runner (worker/migrate.py ensure_ledger) also re-applies the same guarded block on
-- every `make migrate`, so undoing it here would be undone again by the next migrate run.
--
-- If the ledger row must go so 041 re-applies:
--     DELETE FROM public._migrations WHERE filename = '041_v3_migrations_ledger_rls.sql';

SELECT 1;
