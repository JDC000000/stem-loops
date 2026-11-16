-- Reverse of 038_v3_subscriptions_user_id_idx.sql. Safe: the retention rule is
-- correct without the index, only slower.
DROP INDEX IF EXISTS public.subscriptions_user_id_idx;
