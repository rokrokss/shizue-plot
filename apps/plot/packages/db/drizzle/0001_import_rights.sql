ALTER TABLE "characters" ADD COLUMN "imported_from" jsonb;--> statement-breakpoint
ALTER TABLE "plot_assets" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN "rights_confirmed_at" timestamp with time zone;