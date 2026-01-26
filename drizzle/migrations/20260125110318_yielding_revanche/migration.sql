CREATE TABLE `upload_requests` (
	`id` integer PRIMARY KEY,
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`file_name` text NOT NULL,
	`parent_path` text DEFAULT '' NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
ALTER TABLE `objects` ADD `path` text NOT NULL;--> statement-breakpoint
ALTER TABLE `objects` ADD `parent_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_objects` (
	`id` integer PRIMARY KEY,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL UNIQUE,
	`parent_path` text DEFAULT '' NOT NULL,
	`key` text,
	`thumbnail` text,
	`content_type` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_objects`(`owner_id`, `id`, `name`, `key`, `thumbnail`, `content_type`, `size`, `created_at`, `updated_at`) SELECT `owner_id`, `id`, `name`, `key`, `thumbnail`, `content_type`, `size`, `created_at`, `updated_at` FROM `objects`;--> statement-breakpoint
DROP TABLE `objects`;--> statement-breakpoint
ALTER TABLE `__new_objects` RENAME TO `objects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `objects_ownerId_idx`;--> statement-breakpoint
CREATE INDEX `objects_owner_id_idx` ON `objects` (`owner_id`);--> statement-breakpoint
CREATE INDEX `objects_parent_path_idx` ON `objects` (`parent_path`);--> statement-breakpoint
CREATE INDEX `objects_owner_id_parent_path_idx` ON `objects` (`owner_id`,`parent_path`);--> statement-breakpoint
CREATE INDEX `upload_requests_owner_id_idx` ON `upload_requests` (`owner_id`);--> statement-breakpoint
CREATE INDEX `upload_requests_key_idx` ON `upload_requests` (`key`);--> statement-breakpoint
CREATE INDEX `upload_requests_status_idx` ON `upload_requests` (`status`);