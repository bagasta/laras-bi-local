CREATE TABLE `cloud_connections` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`encrypted_token` text NOT NULL,
	`organization` text NOT NULL,
	`project_name` text NOT NULL,
	`project_ref` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provisioning_jobs` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`phase` text DEFAULT 'pending' NOT NULL,
	`project_ref` text,
	`create_attempted` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`updated_at` integer NOT NULL
);
