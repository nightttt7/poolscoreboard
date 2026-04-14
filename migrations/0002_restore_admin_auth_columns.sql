ALTER TABLE `users` ADD COLUMN `username` text;
ALTER TABLE `users` ADD COLUMN `password_salt` text;
ALTER TABLE `users` ADD COLUMN `password_hash` text;

CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
