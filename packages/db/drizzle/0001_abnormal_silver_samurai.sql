CREATE TABLE `asset_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`kind` text NOT NULL,
	`executed_at` text NOT NULL,
	`units` text NOT NULL,
	`price_per_unit` text NOT NULL,
	`currency` text NOT NULL,
	`fees_minor` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `investment_assets` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`unit_symbol` text,
	`isin` text,
	`provider_symbol` text,
	`manual_price_per_unit` text,
	`manual_priced_at` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
