CREATE TABLE `amortization_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`liability_id` text NOT NULL,
	`initial_capital_minor` integer NOT NULL,
	`annual_interest_rate` text NOT NULL,
	`term_months` integer NOT NULL,
	`start_date` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`liability_id`) REFERENCES `liabilities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `amortization_plans_liability_unique` ON `amortization_plans` (`liability_id`);--> statement-breakpoint
CREATE TABLE `interest_rate_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`revision_date` text NOT NULL,
	`new_annual_interest_rate` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `amortization_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interest_rate_revisions_plan_date_unique` ON `interest_rate_revisions` (`plan_id`,`revision_date`);--> statement-breakpoint
ALTER TABLE `liabilities` ADD `debt_model` text;