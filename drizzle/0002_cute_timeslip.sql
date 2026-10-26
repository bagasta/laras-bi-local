CREATE TABLE `ai_connections` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`encrypted_key` text NOT NULL,
	`model` text NOT NULL,
	`updated_at` integer NOT NULL
);
