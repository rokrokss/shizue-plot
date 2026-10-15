-- A reader's own RisuAI modules (RisuAI's db.modules / enabledModules / chat.modules):
-- the library, the chats that turn one on, and the lore vectors one reader's play
-- on a plot holds that the work does not (Lua-rewritten member lore, library
-- module lore).
CREATE TABLE "reader_lore_vectors" (
	"user_id" text NOT NULL,
	"plot_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	CONSTRAINT "reader_lore_vectors_user_id_plot_id_content_hash_pk" PRIMARY KEY("user_id","plot_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "reader_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"module" jsonb NOT NULL,
	"assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_globally" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "modules" jsonb;--> statement-breakpoint
ALTER TABLE "reader_lore_vectors" ADD CONSTRAINT "reader_lore_vectors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_lore_vectors" ADD CONSTRAINT "reader_lore_vectors_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_modules" ADD CONSTRAINT "reader_modules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reader_modules_user_id_idx" ON "reader_modules" USING btree ("user_id","created_at");