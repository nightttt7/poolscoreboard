ALTER TABLE `matches` ADD COLUMN `archive_version` integer NOT NULL DEFAULT 1;

CREATE TABLE `match_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `match_id` text NOT NULL,
  `archive_version` integer NOT NULL,
  `code` text NOT NULL,
  `status` text NOT NULL,
  `winner_slot` integer,
  `target_wins` integer NOT NULL,
  `player1_name` text,
  `player2_name` text,
  `player1_wins` integer NOT NULL,
  `player2_wins` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer NOT NULL,
  `snapshot` text NOT NULL
);

CREATE UNIQUE INDEX `match_history_match_archive_version_unique` ON `match_history` (`match_id`, `archive_version`);