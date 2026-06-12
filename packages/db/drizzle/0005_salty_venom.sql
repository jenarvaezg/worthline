CREATE TABLE `asset_valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`value_minor` integer NOT NULL,
	`valuation_date` text NOT NULL,
	`adjusts_prior_curve` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_valuations_asset_date_unique` ON `asset_valuations` (`asset_id`,`valuation_date`);--> statement-breakpoint
ALTER TABLE `assets` ADD `annual_appreciation_rate` text;