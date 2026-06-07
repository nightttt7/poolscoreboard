CREATE TABLE `users` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `current_match_id` text,
  `username` text,
  `password_salt` text,
  `password_hash` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);

CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` integer NOT NULL,
  `token_hash` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);

CREATE TABLE `matches` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL,
  `target_wins` integer NOT NULL DEFAULT 7,
  `opening_slot` integer NOT NULL DEFAULT 1,
  `archive_version` integer NOT NULL DEFAULT 1,
  `player1_user_id` integer,
  `player1_name` text,
  `player2_user_id` integer,
  `player2_name` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE UNIQUE INDEX `matches_code_unique` ON `matches` (`code`);

CREATE TABLE `frames` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `match_id` text NOT NULL,
  `frame_number` integer NOT NULL,
  `breaker_slot` integer,
  `winner_slot` integer,
  `player1_fouls` integer NOT NULL DEFAULT 0,
  `player2_fouls` integer NOT NULL DEFAULT 0,
  `ended_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);

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
