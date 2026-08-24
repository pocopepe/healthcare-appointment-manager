CREATE TABLE `login_attempts` (
	`identifier` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
