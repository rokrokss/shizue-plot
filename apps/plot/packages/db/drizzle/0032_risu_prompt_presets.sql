ALTER TABLE "chats" ALTER COLUMN "preset" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "jailbreak" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "formating_order" jsonb;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "prompt_template" jsonb;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "group_template" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "group_other_bot_role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
UPDATE "chats" SET "preset" = 'default' WHERE "preset" <> 'default';
