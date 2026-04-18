ALTER TABLE `matches` ADD COLUMN `opening_slot` integer NOT NULL DEFAULT 1;

ALTER TABLE `frames` ADD COLUMN `breaker_slot` integer;