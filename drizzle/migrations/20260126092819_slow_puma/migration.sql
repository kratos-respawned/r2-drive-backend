ALTER TABLE `user` ADD `storage_allocated` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `storage_used` integer DEFAULT 0 NOT NULL;