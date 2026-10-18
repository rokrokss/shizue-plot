CREATE TABLE "model_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"content_hash" text NOT NULL,
	"catalog" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_presets" ADD COLUMN "kind" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_presets" ADD COLUMN "source_profile" jsonb;--> statement-breakpoint
ALTER TABLE "model_presets" ADD COLUMN "profile_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "model_presets" ADD COLUMN "user_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Every preset from before the registry waits for the app's start to look at it
-- (`convertLegacyPresets`): one on a key whose model a registry profile names
-- becomes that profile's preset, any other a custom one.
UPDATE "model_presets" SET "kind" = 'legacy';