DROP TABLE IF EXISTS `frames`;
DROP TABLE IF EXISTS `matches`;
DROP TABLE IF EXISTS `sessions`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `todos`;

CREATE TABLE `users` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `current_match_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

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
  `winner_slot` integer,
  `player1_fouls` integer NOT NULL DEFAULT 0,
  `player2_fouls` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
