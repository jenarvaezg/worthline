CREATE TABLE `asset_price_cache` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`price` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`price_date` text,
	`fetched_at` text NOT NULL,
	`freshness_state` text DEFAULT 'manual' NOT NULL,
	`stale_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `liabilities` ADD `deleted_at` text;