PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_objects` (
	`id` integer PRIMARY KEY,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`parent_path` text DEFAULT '' NOT NULL,
	`key` text,
	`thumbnail` text,
	`content_type` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `objects_owner_id_path_unique` UNIQUE(`owner_id`,`path`)
);
--> statement-breakpoint
INSERT INTO `__new_objects`(`id`, `owner_id`, `name`, `path`, `parent_path`, `key`, `thumbnail`, `content_type`, `size`, `created_at`, `updated_at`) SELECT `id`, `owner_id`, `name`, `path`, `parent_path`, `key`, `thumbnail`, `content_type`, `size`, `created_at`, `updated_at` FROM `objects`;--> statement-breakpoint
DROP TABLE `objects`;--> statement-breakpoint
ALTER TABLE `__new_objects` RENAME TO `objects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `objects_owner_id_idx` ON `objects` (`owner_id`);--> statement-breakpoint
CREATE INDEX `objects_parent_path_idx` ON `objects` (`parent_path`);--> statement-breakpoint
CREATE INDEX `objects_owner_id_parent_path_idx` ON `objects` (`owner_id`,`parent_path`);