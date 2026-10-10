ALTER TABLE "chats" ADD COLUMN "imported_from" jsonb;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "importing" boolean DEFAULT false NOT NULL;