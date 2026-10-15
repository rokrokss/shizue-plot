-- RisuAI's remaining reader-side switches: a chat's "Local Toggles" and the values
-- kept for it, the works a library module is on for (a character's `modules`), and
-- a reader preset's toggles and module integration.
ALTER TABLE "chats" ADD COLUMN "local_toggles" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "local_global_variables" jsonb;--> statement-breakpoint
ALTER TABLE "reader_modules" ADD COLUMN "plot_ids" jsonb;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "toggles" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "module_integration" text DEFAULT '' NOT NULL;