ALTER TABLE `upload_requests` ADD `has_thumbnail` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `user` SET `storage_allocated` = 10485760 WHERE `storage_allocated` = 0;
