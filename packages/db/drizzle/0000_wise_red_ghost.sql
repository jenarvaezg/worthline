CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_ownerships` (
	`asset_id` text NOT NULL,
	`member_id` text NOT NULL,
	`share_bps` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `member_id`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`current_value_minor` integer NOT NULL,
	`liquidity_tier` text NOT NULL,
	`is_primary_residence` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `liabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`current_balance_minor` integer NOT NULL,
	`associated_asset_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`associated_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `liability_ownerships` (
	`liability_id` text NOT NULL,
	`member_id` text NOT NULL,
	`share_bps` integer NOT NULL,
	PRIMARY KEY(`liability_id`, `member_id`),
	FOREIGN KEY (`liability_id`) REFERENCES `liabilities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `member_group_members` (
	`group_id` text NOT NULL,
	`member_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	PRIMARY KEY(`group_id`, `member_id`),
	FOREIGN KEY (`group_id`) REFERENCES `member_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `member_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`disabled_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`scope_label` text NOT NULL,
	`captured_at` text NOT NULL,
	`date_key` text NOT NULL,
	`month_key` text NOT NULL,
	`is_monthly_close` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`total_net_worth_minor` integer NOT NULL,
	`liquid_net_worth_minor` integer NOT NULL,
	`housing_equity_minor` integer NOT NULL,
	`gross_assets_minor` integer NOT NULL,
	`debts_minor` integer NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_scope_date_unique` ON `snapshots` (`scope_id`,`date_key`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`base_currency` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "workspace_id_default" CHECK("workspace"."id" = 'default'),
	CONSTRAINT "workspace_mode_enum" CHECK("workspace"."mode" IN ('individual', 'household'))
);
