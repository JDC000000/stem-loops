-- 035_v3_spend_global_brake_down.sql — reverse of 035. Run by hand only; the runner globs
-- migrations/*.sql and never descends into down/.
--
-- ORDER IS THE REVERSE OF THE DEPLOY: roll the WORKER back first, then run this.
-- If this runs while a worker carrying worker.spend_gate is still up, that worker finds no
-- `spend_global` row, treats it as ENGAGED, and claims nothing until it is rolled back.
-- (Safe — nothing is spent — but the queue stalls.)

DELETE FROM public.kill_switches WHERE scope = 'spend_global';
ALTER TABLE public.kill_switches DROP CONSTRAINT IF EXISTS kill_switches_scope_known;
