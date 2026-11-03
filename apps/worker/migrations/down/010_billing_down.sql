-- Down for 010_billing.sql. Drops only objects 010 created (loses their rows).
-- Does NOT drop the auth stub schema or service_role/authenticated roles — they
-- may be in use by other migrations or by Supabase itself.

DROP VIEW IF EXISTS v_credit_balance;

DROP POLICY IF EXISTS entitlements_select_own       ON entitlements;
DROP POLICY IF EXISTS entitlements_service_role_all ON entitlements;
DROP POLICY IF EXISTS subscriptions_select_own          ON subscriptions;
DROP POLICY IF EXISTS subscriptions_service_role_all    ON subscriptions;
DROP POLICY IF EXISTS credit_consumption_select_own          ON credit_consumption;
DROP POLICY IF EXISTS credit_consumption_service_role_all    ON credit_consumption;
DROP POLICY IF EXISTS credit_purchases_select_own          ON credit_purchases;
DROP POLICY IF EXISTS credit_purchases_service_role_all    ON credit_purchases;
DROP POLICY IF EXISTS users_select_own          ON users;
DROP POLICY IF EXISTS users_update_own          ON users;
DROP POLICY IF EXISTS users_service_role_all    ON users;

DROP TABLE IF EXISTS entitlements;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS credit_consumption;
DROP TABLE IF EXISTS credit_purchases;
DROP TABLE IF EXISTS users;

DELETE FROM _migrations WHERE filename = '010_billing.sql';
