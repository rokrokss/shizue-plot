-- A SillyTavern chat's attached text files come in as chat attachments under
-- their own names, and a reader preset keeps RisuAI's template default variables.
ALTER TABLE "chat_attachments" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD COLUMN "default_variables" text DEFAULT '' NOT NULL;
