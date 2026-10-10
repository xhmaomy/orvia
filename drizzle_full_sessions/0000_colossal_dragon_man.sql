CREATE TABLE `ov_agent_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agent_id` int NOT NULL,
	`version` varchar(40) NOT NULL,
	`model_id` int NOT NULL,
	`role` varchar(160) NOT NULL,
	`mission` text,
	`system_prompt` text,
	`config_json` json,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `ov_agent_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_versions_agent_version_unique` UNIQUE(`agent_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `ov_agents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`project_id` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` text,
	`capabilities_json` json,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ov_agents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_decisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`project_id` int NOT NULL,
	`workflow_run_id` int,
	`question` text NOT NULL,
	`decision` text,
	`decided_by` varchar(80) NOT NULL DEFAULT 'human',
	`decision_status` enum('pending','approved','rejected','superseded') NOT NULL DEFAULT 'pending',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `ov_decisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`project_id` int NOT NULL,
	`workflow_run_id` int,
	`task_id` int,
	`session_id` int,
	`agent_id` int,
	`type` varchar(120) NOT NULL,
	`payload_json` json,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `ov_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_model_providers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`type` varchar(80) NOT NULL,
	`base_url` varchar(500),
	`config_json` json,
	`status` enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ov_model_providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_providers_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `ov_models` (
	`id` int AUTO_INCREMENT NOT NULL,
	`provider_id` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`display_name` varchar(200) NOT NULL,
	`capabilities_json` json,
	`context_window` int,
	`input_price` varchar(32),
	`output_price` varchar(32),
	`status` enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ov_models_id` PRIMARY KEY(`id`),
	CONSTRAINT `models_provider_name_unique` UNIQUE(`provider_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `ov_projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` text,
	`status` enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ov_projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`task_id` int NOT NULL,
	`agent_id` int,
	`runtime` varchar(80) NOT NULL DEFAULT 'pi',
	`session_status` enum('pending','running','paused','completed','failed') NOT NULL DEFAULT 'pending',
	`input_json` json,
	`output_json` json,
	`started_at` datetime,
	`completed_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `ov_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflow_run_id` int NOT NULL,
	`agent_id` int,
	`name` varchar(200) NOT NULL,
	`task_status` enum('pending','running','paused','completed','failed') NOT NULL DEFAULT 'pending',
	`input_json` json,
	`output_json` json,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ov_tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_workflow_nodes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflow_id` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`capability` varchar(120) NOT NULL,
	`skill` varchar(120),
	`config_json` json,
	CONSTRAINT `ov_workflow_nodes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_workflow_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflow_id` int NOT NULL,
	`run_status` enum('pending','running','paused','completed','failed') NOT NULL DEFAULT 'pending',
	`started_at` datetime,
	`completed_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `ov_workflow_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ov_workflows` (
	`id` int AUTO_INCREMENT NOT NULL,
	`project_id` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`version` varchar(40) NOT NULL,
	`definition_json` json,
	`status` enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'draft',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ov_workflows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ov_agent_versions` ADD CONSTRAINT `ov_agent_versions_agent_id_ov_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `ov_agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_agent_versions` ADD CONSTRAINT `ov_agent_versions_model_id_ov_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `ov_models`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_agents` ADD CONSTRAINT `ov_agents_project_id_ov_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `ov_projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_decisions` ADD CONSTRAINT `ov_decisions_project_id_ov_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `ov_projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_decisions` ADD CONSTRAINT `ov_decisions_workflow_run_id_ov_workflow_runs_id_fk` FOREIGN KEY (`workflow_run_id`) REFERENCES `ov_workflow_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_events` ADD CONSTRAINT `ov_events_project_id_ov_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `ov_projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_events` ADD CONSTRAINT `ov_events_workflow_run_id_ov_workflow_runs_id_fk` FOREIGN KEY (`workflow_run_id`) REFERENCES `ov_workflow_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_events` ADD CONSTRAINT `ov_events_task_id_ov_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `ov_tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_events` ADD CONSTRAINT `ov_events_session_id_ov_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `ov_sessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_events` ADD CONSTRAINT `ov_events_agent_id_ov_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `ov_agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_models` ADD CONSTRAINT `ov_models_provider_id_ov_model_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `ov_model_providers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_sessions` ADD CONSTRAINT `ov_sessions_task_id_ov_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `ov_tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_sessions` ADD CONSTRAINT `ov_sessions_agent_id_ov_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `ov_agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_tasks` ADD CONSTRAINT `ov_tasks_workflow_run_id_ov_workflow_runs_id_fk` FOREIGN KEY (`workflow_run_id`) REFERENCES `ov_workflow_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_tasks` ADD CONSTRAINT `ov_tasks_agent_id_ov_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `ov_agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_workflow_nodes` ADD CONSTRAINT `ov_workflow_nodes_workflow_id_ov_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `ov_workflows`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_workflow_runs` ADD CONSTRAINT `ov_workflow_runs_workflow_id_ov_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `ov_workflows`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ov_workflows` ADD CONSTRAINT `ov_workflows_project_id_ov_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `ov_projects`(`id`) ON DELETE no action ON UPDATE no action;