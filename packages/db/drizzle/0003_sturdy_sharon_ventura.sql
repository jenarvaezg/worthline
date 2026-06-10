CREATE TABLE `snapshot_holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`holding_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`liquidity_tier` text,
	`value_minor` integer NOT NULL,
	`units` text,
	`unit_price` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_holdings_snapshot_kind_holding_unique` ON `snapshot_holdings` (`snapshot_id`,`kind`,`holding_id`);--> statement-breakpoint
CREATE TABLE `warning_overrides` (
	`code` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`code`, `entity_id`)
);
