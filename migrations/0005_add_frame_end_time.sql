ALTER TABLE frames ADD COLUMN ended_at INTEGER;
-- Existing winner frames did not store the exact win time; updated_at is the best available backfill.
UPDATE frames SET ended_at = updated_at WHERE winner_slot IN (1, 2);
