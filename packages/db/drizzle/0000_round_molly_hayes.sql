CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint

CREATE TRIGGER `system_settings_set_updated_at`
AFTER UPDATE ON `system_settings`
FOR EACH ROW
WHEN NEW.`updated_at` = OLD.`updated_at`
BEGIN
	UPDATE `system_settings`
	SET `updated_at` = CURRENT_TIMESTAMP
	WHERE `key` = NEW.`key`;
END;
