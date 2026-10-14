CREATE TABLE "reader_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"main" text DEFAULT '' NOT NULL,
	"global_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "reader_preset_id" uuid;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD CONSTRAINT "reader_presets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reader_presets_user_id_idx" ON "reader_presets" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_reader_preset_id_reader_presets_id_fk" FOREIGN KEY ("reader_preset_id") REFERENCES "public"."reader_presets"("id") ON DELETE set null ON UPDATE no action;