CREATE TABLE `liability_balance_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`liability_id` text NOT NULL,
	`balance_minor` integer NOT NULL,
	`anchor_date` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`liability_id`) REFERENCES `liabilities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `liability_balance_anchors_liability_date_unique` ON `liability_balance_anchors` (`liability_id`,`anchor_date`);