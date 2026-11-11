-- Down for 032_v3_revoke_security_definer_grants.sql.
--
-- Restores the exact prior state: anon and authenticated held EXECUTE on both
-- SECURITY DEFINER trigger functions (from a historical blanket
-- GRANT EXECUTE ON ALL FUNCTIONS, not a deliberate grant).
--
-- Note this re-introduces the Supabase advisor findings 0028/0029. It exists so
-- the migration is reversible, not because reverting is desirable.

GRANT EXECUTE ON FUNCTION public.handle_new_user()        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_credit_decrement() TO anon, authenticated;
