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
	\`valuation_method\` text,
	\`valuation_cadence\` text,
	\`instrument\` text,
	\`annual_appreciation_rate\` text,
	\`connected_source_id\` text,
	\`deleted_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`assets_deleted_at_idx\` ON \`assets\` (\`name\`) WHERE \`deleted_at\` IS NOT NULL;--> statement-breakpoint
CREATE TABLE \`liabilities\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`currency\` text NOT NULL,
	\`current_balance_minor\` integer NOT NULL,
	\`associated_asset_id\` text,
	\`debt_model\` text,
	\`valuation_method\` text,
	\`valuation_cadence\` text,
	\`instrument\` text,
	\`deleted_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`associated_asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX \`liabilities_deleted_at_idx\` ON \`liabilities\` (\`name\`) WHERE \`deleted_at\` IS NOT NULL;--> statement-breakpoint
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
CREATE TABLE \`agent_view_public_ids\` (
	\`entity_type\` text NOT NULL,
	\`entity_id\` text NOT NULL,
	\`public_id\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(\`entity_type\`, \`entity_id\`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`agent_view_public_ids_public_id_unique\` ON \`agent_view_public_ids\` (\`public_id\`);--> statement-breakpoint
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
	\`birth_year\` integer,
	\`fiscal_country\` text,
	\`risk_tolerance\` text,
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
CREATE TABLE \`fact_batch\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`trigger\` text NOT NULL,
	\`connected_source_id\` text,
	\`sync_run_id\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`asset_operations\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`asset_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`executed_at\` text NOT NULL,
	\`occurred_at\` text,
	\`units\` text NOT NULL,
	\`price_per_unit\` text NOT NULL,
	\`currency\` text NOT NULL,
	\`fees_minor\` integer DEFAULT 0 NOT NULL,
	\`source\` text DEFAULT 'manual' NOT NULL,
	\`batch_id\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`batch_id\`) REFERENCES \`fact_batch\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX \`asset_operations_asset_executed_idx\` ON \`asset_operations\` (\`asset_id\`,\`executed_at\`,\`occurred_at\`,\`id\`);--> statement-breakpoint
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
CREATE TABLE \`exposure_profiles\` (
	\`key\` text PRIMARY KEY NOT NULL,
	\`source\` text DEFAULT 'user' NOT NULL,
	\`declared_at\` text,
	\`tracked_index\` text,
	\`ter\` text,
	\`hedged\` integer DEFAULT 0 NOT NULL,
	\`breakdowns_json\` text DEFAULT '{}' NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`payouts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`holding_id\` text NOT NULL,
	\`date\` text NOT NULL,
	\`amount_minor\` integer NOT NULL,
	\`note\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`holding_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`payouts_holding_date_idx\` ON \`payouts\` (\`holding_id\`,\`date\`,\`id\`);--> statement-breakpoint
CREATE TABLE \`payout_schedules\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`holding_id\` text NOT NULL,
	\`label\` text NOT NULL,
	\`amount_minor\` integer NOT NULL,
	\`cadence\` text NOT NULL,
	\`start_date\` text NOT NULL,
	\`end_date\` text,
	\`exclusions_json\` text DEFAULT '[]' NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`holding_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`payout_schedules_holding_idx\` ON \`payout_schedules\` (\`holding_id\`,\`id\`);--> statement-breakpoint
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
CREATE INDEX \`audit_log_entity_created_idx\` ON \`audit_log\` (\`entity_id\`,\`created_at\`);--> statement-breakpoint
CREATE TABLE \`snapshot_holdings\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`snapshot_id\` text NOT NULL,
	\`holding_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`label\` text NOT NULL,
	\`liquidity_tier\` text,
	\`secures_housing\` integer DEFAULT 0 NOT NULL,
	\`counts_as_housing\` integer DEFAULT 0 NOT NULL,
	\`value_minor\` integer NOT NULL,
	\`units\` text,
	\`unit_price\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`snapshot_id\`) REFERENCES \`snapshots\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`snapshot_holdings_snapshot_kind_holding_unique\` ON \`snapshot_holdings\` (\`snapshot_id\`,\`kind\`,\`holding_id\`);--> statement-breakpoint
CREATE INDEX \`snapshot_holdings_holding_kind_idx\` ON \`snapshot_holdings\` (\`holding_id\`,\`kind\`);--> statement-breakpoint
CREATE TABLE \`snapshot_position_holdings\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`snapshot_id\` text NOT NULL,
	\`parent_holding_id\` text NOT NULL,
	\`position_key\` text NOT NULL,
	\`label\` text NOT NULL,
	\`value_minor\` integer NOT NULL,
	\`metal\` text,
	\`image_url\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`snapshot_id\`) REFERENCES \`snapshots\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`snapshot_position_holdings_snapshot_holding_key_unique\` ON \`snapshot_position_holdings\` (\`snapshot_id\`,\`parent_holding_id\`,\`position_key\`);--> statement-breakpoint
CREATE TABLE \`asset_valuations\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`asset_id\` text NOT NULL,
	\`value_minor\` integer NOT NULL,
	\`valuation_date\` text NOT NULL,
	\`adjusts_prior_curve\` integer NOT NULL,
	\`source\` text DEFAULT 'manual' NOT NULL,
	\`batch_id\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`batch_id\`) REFERENCES \`fact_batch\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`asset_valuations_asset_date_unique\` ON \`asset_valuations\` (\`asset_id\`,\`valuation_date\`);--> statement-breakpoint
CREATE TABLE \`amortization_plans\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`liability_id\` text NOT NULL,
	\`initial_capital_minor\` integer NOT NULL,
	\`annual_interest_rate\` text NOT NULL,
	\`term_months\` integer NOT NULL,
	\`disbursement_date\` text NOT NULL,
	\`first_payment_date\` text NOT NULL,
	\`original_signing_date\` text,
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
	\`batch_id\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`liability_id\`) REFERENCES \`liabilities\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`batch_id\`) REFERENCES \`fact_batch\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`liability_balance_anchors_liability_date_unique\` ON \`liability_balance_anchors\` (\`liability_id\`,\`anchor_date\`);--> statement-breakpoint
CREATE TABLE \`early_repayments\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`plan_id\` text NOT NULL,
	\`repayment_date\` text NOT NULL,
	\`amount_minor\` integer NOT NULL,
	\`mode\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`plan_id\`) REFERENCES \`amortization_plans\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`early_repayments_plan_date_unique\` ON \`early_repayments\` (\`plan_id\`,\`repayment_date\`);--> statement-breakpoint
CREATE TABLE \`liability_balance_rebaselines\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`liability_id\` text NOT NULL,
	\`baseline_date\` text NOT NULL,
	\`outstanding_balance_minor\` integer NOT NULL,
	\`end_date\` text NOT NULL,
	\`next_payment_date\` text NOT NULL,
	\`annual_interest_rate\` text NOT NULL,
	\`monthly_payment_minor\` integer NOT NULL,
	\`input_mode\` text NOT NULL,
	\`starts_at_baseline\` integer DEFAULT 0 NOT NULL,
	\`source\` text DEFAULT 'manual' NOT NULL,
	\`batch_id\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`liability_id\`) REFERENCES \`liabilities\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`batch_id\`) REFERENCES \`fact_batch\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`liability_balance_rebaselines_liability_date_unique\` ON \`liability_balance_rebaselines\` (\`liability_id\`,\`baseline_date\`);--> statement-breakpoint
CREATE TABLE \`connected_sources\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`adapter\` text NOT NULL,
	\`label\` text NOT NULL,
	\`asset_id\` text NOT NULL,
	\`credentials_json\` text NOT NULL,
	\`token_json\` text,
	\`last_sync_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`positions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`source_id\` text NOT NULL,
	\`kind\` text DEFAULT 'coin' NOT NULL,
	\`external_id\` text,
	\`name\` text NOT NULL,
	\`liquidity_tier\` text NOT NULL,
	\`currency\` text NOT NULL,
	\`catalogue_id\` text,
	\`issue_id\` integer,
	\`grade\` text,
	\`quantity\` integer,
	\`year\` integer,
	\`metal\` text,
	\`fineness_millis\` integer,
	\`weight_grams\` real,
	\`purchase_date\` text,
	\`purchase_price_minor\` integer,
	\`obverse_thumb_url\` text,
	\`metal_value_minor\` integer,
	\`numismatic_value_minor\` integer,
	\`numismatic_fetched_at\` text,
	\`symbol\` text,
	\`balance\` text,
	\`wallet\` text,
	\`unit_price\` text,
	\`image_url\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`source_id\`) REFERENCES \`connected_sources\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`goals\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`scope_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`target_amount_minor\` integer NOT NULL,
	\`deadline\` text NOT NULL,
	\`priority\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`planned_contributions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`scope_id\` text NOT NULL,
	\`destination_holding_id\` text NOT NULL,
	\`amount_json\` text NOT NULL,
	\`cadence_json\` text NOT NULL,
	\`start_date\` text NOT NULL,
	\`end_date\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`destination_holding_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`planned_contributions_scope_idx\` ON \`planned_contributions\` (\`scope_id\`,\`id\`);--> statement-breakpoint
CREATE TABLE \`contribution_occurrence_reconciliations\` (
	\`occurrence_id\` text PRIMARY KEY NOT NULL,
	\`contribution_id\` text NOT NULL,
	\`state\` text NOT NULL,
	\`stored_execution_minor\` integer,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`contribution_id\`) REFERENCES \`planned_contributions\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`contribution_reconciliations_contribution_idx\` ON \`contribution_occurrence_reconciliations\` (\`contribution_id\`,\`occurrence_id\`);--> statement-breakpoint
CREATE TABLE \`contribution_occurrence_operations\` (
	\`occurrence_id\` text NOT NULL,
	\`operation_id\` text NOT NULL,
	PRIMARY KEY(\`occurrence_id\`, \`operation_id\`),
	FOREIGN KEY (\`occurrence_id\`) REFERENCES \`contribution_occurrence_reconciliations\`(\`occurrence_id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`operation_id\`) REFERENCES \`asset_operations\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`contribution_occurrence_operation_unique\` ON \`contribution_occurrence_operations\` (\`operation_id\`);--> statement-breakpoint
CREATE TABLE \`assistant_proposals\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`kind\` text NOT NULL,
	\`status\` text DEFAULT 'draft' NOT NULL,
	\`resolved_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`assistant_proposal_documents\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`proposal_id\` text NOT NULL,
	\`sequence\` integer NOT NULL,
	\`name\` text NOT NULL,
	\`sha256\` text NOT NULL,
	\`provenance\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`proposal_id\`) REFERENCES \`assistant_proposals\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`assistant_proposal_documents_sequence_unique\` ON \`assistant_proposal_documents\` (\`proposal_id\`,\`sequence\`);--> statement-breakpoint
CREATE TABLE \`assistant_proposal_facts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`document_id\` text NOT NULL,
	\`ordinal\` integer NOT NULL,
	\`kind\` text NOT NULL,
	\`payload_json\` text NOT NULL,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`document_id\`) REFERENCES \`assistant_proposal_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`assistant_proposal_facts_ordinal_unique\` ON \`assistant_proposal_facts\` (\`document_id\`,\`ordinal\`);--> statement-breakpoint
CREATE TABLE \`goal_holdings\` (
	\`goal_id\` text NOT NULL,
	\`asset_id\` text NOT NULL,
	PRIMARY KEY(\`goal_id\`, \`asset_id\`),
	FOREIGN KEY (\`goal_id\`) REFERENCES \`goals\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
`;
