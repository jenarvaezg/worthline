// GENERATED from src/schema.ts via `npm run db:generate` (drizzle-kit).
// Do not edit by hand — change src/schema.ts and regenerate.
//
// This is the runtime form of the migration in ./drizzle: inlining the DDL as a
// string keeps it bundler-safe (no filesystem read at runtime, which Turbopack
// cannot resolve once the package is bundled). SQLite ignores the `--` comments.

export const schemaSql = `
CREATE TABLE \`app_settings\` (
	\`key\` text PRIMARY KEY NOT NULL,
	\`value\` text NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`asset_ownerships\` (
	\`asset_id\` text NOT NULL,
	\`member_id\` text NOT NULL,
	\`share_bps\` integer NOT NULL,
	PRIMARY KEY(\`asset_id\`, \`member_id\`),
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE \`assets\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`currency\` text NOT NULL,
	\`current_value_minor\` integer NOT NULL,
	\`liquidity_tier\` text NOT NULL,
	\`is_primary_residence\` integer DEFAULT 0 NOT NULL,
	\`annual_appreciation_rate\` text,
	\`deleted_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`liabilities\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`currency\` text NOT NULL,
	\`current_balance_minor\` integer NOT NULL,
	\`associated_asset_id\` text,
	\`debt_model\` text,
	\`deleted_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`associated_asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE \`liability_ownerships\` (
	\`liability_id\` text NOT NULL,
	\`member_id\` text NOT NULL,
	\`share_bps\` integer NOT NULL,
	PRIMARY KEY(\`liability_id\`, \`member_id\`),
	FOREIGN KEY (\`liability_id\`) REFERENCES \`liabilities\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE \`member_group_members\` (
	\`group_id\` text NOT NULL,
	\`member_id\` text NOT NULL,
	\`sort_order\` integer NOT NULL,
	PRIMARY KEY(\`group_id\`, \`member_id\`),
	FOREIGN KEY (\`group_id\`) REFERENCES \`member_groups\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`member_groups\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`members\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`disabled_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`snapshots\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`scope_id\` text NOT NULL,
	\`scope_label\` text NOT NULL,
	\`captured_at\` text NOT NULL,
	\`date_key\` text NOT NULL,
	\`month_key\` text NOT NULL,
	\`is_monthly_close\` integer DEFAULT 0 NOT NULL,
	\`currency\` text NOT NULL,
	\`total_net_worth_minor\` integer NOT NULL,
	\`liquid_net_worth_minor\` integer NOT NULL,
	\`housing_equity_minor\` integer NOT NULL,
	\`gross_assets_minor\` integer NOT NULL,
	\`debts_minor\` integer NOT NULL,
	\`warnings_json\` text DEFAULT '[]' NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`snapshots_scope_date_unique\` ON \`snapshots\` (\`scope_id\`,\`date_key\`);--> statement-breakpoint
CREATE TABLE \`workspace\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`mode\` text NOT NULL,
	\`base_currency\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "workspace_id_default" CHECK("workspace"."id" = 'default'),
	CONSTRAINT "workspace_mode_enum" CHECK("workspace"."mode" IN ('individual', 'household'))
);
--> statement-breakpoint
CREATE TABLE \`asset_operations\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`asset_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`executed_at\` text NOT NULL,
	\`units\` text NOT NULL,
	\`price_per_unit\` text NOT NULL,
	\`currency\` text NOT NULL,
	\`fees_minor\` integer DEFAULT 0 NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`investment_assets\` (
	\`asset_id\` text PRIMARY KEY NOT NULL,
	\`unit_symbol\` text,
	\`isin\` text,
	\`price_provider\` text,
	\`provider_symbol\` text,
	\`manual_price_per_unit\` text,
	\`manual_priced_at\` text,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`asset_price_cache\` (
	\`asset_id\` text PRIMARY KEY NOT NULL,
	\`currency\` text NOT NULL,
	\`price\` text NOT NULL,
	\`source\` text DEFAULT 'manual' NOT NULL,
	\`price_date\` text,
	\`fetched_at\` text NOT NULL,
	\`freshness_state\` text DEFAULT 'manual' NOT NULL,
	\`stale_reason\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`audit_log\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`action\` text NOT NULL,
	\`entity_type\` text NOT NULL,
	\`entity_id\` text NOT NULL,
	\`details_json\` text DEFAULT '{}' NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`snapshot_holdings\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`snapshot_id\` text NOT NULL,
	\`holding_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`label\` text NOT NULL,
	\`liquidity_tier\` text,
	\`value_minor\` integer NOT NULL,
	\`units\` text,
	\`unit_price\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`snapshot_id\`) REFERENCES \`snapshots\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`snapshot_holdings_snapshot_kind_holding_unique\` ON \`snapshot_holdings\` (\`snapshot_id\`,\`kind\`,\`holding_id\`);--> statement-breakpoint
CREATE TABLE \`asset_valuations\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`asset_id\` text NOT NULL,
	\`value_minor\` integer NOT NULL,
	\`valuation_date\` text NOT NULL,
	\`adjusts_prior_curve\` integer NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`asset_valuations_asset_date_unique\` ON \`asset_valuations\` (\`asset_id\`,\`valuation_date\`);--> statement-breakpoint
CREATE TABLE \`amortization_plans\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`liability_id\` text NOT NULL,
	\`initial_capital_minor\` integer NOT NULL,
	\`annual_interest_rate\` text NOT NULL,
	\`term_months\` integer NOT NULL,
	\`start_date\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`liability_id\`) REFERENCES \`liabilities\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`amortization_plans_liability_unique\` ON \`amortization_plans\` (\`liability_id\`);--> statement-breakpoint
CREATE TABLE \`interest_rate_revisions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`plan_id\` text NOT NULL,
	\`revision_date\` text NOT NULL,
	\`new_annual_interest_rate\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`plan_id\`) REFERENCES \`amortization_plans\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`interest_rate_revisions_plan_date_unique\` ON \`interest_rate_revisions\` (\`plan_id\`,\`revision_date\`);--> statement-breakpoint
CREATE TABLE \`liability_balance_anchors\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`liability_id\` text NOT NULL,
	\`balance_minor\` integer NOT NULL,
	\`anchor_date\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`liability_id\`) REFERENCES \`liabilities\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`liability_balance_anchors_liability_date_unique\` ON \`liability_balance_anchors\` (\`liability_id\`,\`anchor_date\`);
`;
