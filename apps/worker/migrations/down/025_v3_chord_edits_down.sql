-- 025_v3_chord_edits_down.sql — drop the chord_edits table. Run by hand only.
-- WARNING: dropping the table discards every captured training signal.
-- Phase 4 account-delete sweep should have run against the surviving rows
-- before this down is applied; after DROP no sweep audit trail remains.

DROP TABLE IF EXISTS public.chord_edits;
