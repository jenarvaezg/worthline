CREATE TABLE `early_repayments` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`repayment_date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`mode` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `amortization_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `early_repayments_plan_date_unique` ON `early_repayments` (`plan_id`,`repayment_date`);--> statement-breakpoint
ALTER TABLE `assets` ADD `valuation_method` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `instrument` text;--> statement-breakpoint
ALTER TABLE `liabilities` ADD `valuation_method` text;--> statement-breakpoint
ALTER TABLE `liabilities` ADD `instrument` text;