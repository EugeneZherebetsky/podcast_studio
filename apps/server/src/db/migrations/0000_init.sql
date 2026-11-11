CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`mode` text NOT NULL,
	`lang` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` text NOT NULL,
	`path` text NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `episodes_created_at_idx` ON `episodes` (`created_at`);--> statement-breakpoint
CREATE TABLE `job_stages` (
	`job_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`input_hash` text,
	`started_at` text,
	`finished_at` text,
	`error` text,
	PRIMARY KEY(`job_id`, `stage`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text,
	`status` text NOT NULL,
	`current_stage` text,
	`error` text,
	`options` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `playback` (
	`episode_id` text NOT NULL,
	`device_id` text NOT NULL,
	`position_ms` integer NOT NULL,
	`finished` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`episode_id`, `device_id`),
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`mode` text NOT NULL,
	`lang` text NOT NULL,
	`level` text,
	`minutes` integer NOT NULL,
	`schedule` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text
);
--> statement-breakpoint
CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`units` real NOT NULL,
	`cost_usd` real NOT NULL,
	`job_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_ts_idx` ON `usage` (`ts`);--> statement-breakpoint
CREATE TABLE `used_sources` (
	`topic_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`episode_id` text NOT NULL,
	PRIMARY KEY(`topic_id`, `canonical_url`),
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vocab` (
	`lemma` text NOT NULL,
	`lang` text NOT NULL,
	`gloss` text NOT NULL,
	`state` text NOT NULL,
	`due_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`card` text NOT NULL,
	PRIMARY KEY(`lemma`, `lang`)
);
