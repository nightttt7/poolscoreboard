CREATE TABLE `users` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `username` text NOT NULL,
  `password_salt` text NOT NULL,
  `password_hash` text NOT NULL,
  `created_at` integer NOT NULL
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

CREATE TABLE `todos` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `completed` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);