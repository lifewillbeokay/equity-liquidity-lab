CREATE TABLE `curve_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`stock` text NOT NULL,
	`object_key` text,
	`captured_at` text,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`stored_at` integer DEFAULT 0 NOT NULL,
	`origin` text,
	`lease_owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`reference` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `curve_cache_stock` ON `curve_cache` (`stock`);--> statement-breakpoint
CREATE INDEX `curve_cache_expiry` ON `curve_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pool_reads` (
	`key` text PRIMARY KEY NOT NULL,
	`chain` text NOT NULL,
	`block_hash` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pool_reads_expiry` ON `pool_reads` (`expires_at`);--> statement-breakpoint
CREATE TABLE `market_references` (
	`stock` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
