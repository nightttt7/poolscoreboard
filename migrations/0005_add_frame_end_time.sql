ALTER TABLE frames ADD COLUMN ended_at INTEGER;
UPDATE frames SET ended_at = updated_at WHERE winner_slot IN (1, 2);
