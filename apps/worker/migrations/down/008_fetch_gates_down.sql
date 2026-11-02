-- Down for 008_fetch_gates.sql. Drops only objects 008 created (loses their rows).
DROP TABLE IF EXISTS fetch_attempts;
DROP TABLE IF EXISTS blocklist;
DROP TABLE IF EXISTS kill_switches;
DELETE FROM _migrations WHERE filename = '008_fetch_gates.sql';
