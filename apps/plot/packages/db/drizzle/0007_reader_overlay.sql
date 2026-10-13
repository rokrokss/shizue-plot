CREATE TABLE "plot_reader_overlays" (
	"user_id" text NOT NULL,
	"plot_id" uuid NOT NULL,
	"overlay" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plot_reader_overlays_user_id_plot_id_pk" PRIMARY KEY("user_id","plot_id")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "local_lore" jsonb;--> statement-breakpoint
ALTER TABLE "plot_reader_overlays" ADD CONSTRAINT "plot_reader_overlays_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plot_reader_overlays" ADD CONSTRAINT "plot_reader_overlays_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The per-chat overlays move to the reader and the plot: for each pair, the
-- overlay of the chat touched last. Several chats of one reader on one plot held
-- separate rewrites of the same character; RisuAI's character holds one, the
-- last any script left, so the chat whose overlay was written most recently is
-- the best stand-in for it — a field-by-field merge across chats could build a
-- character no chat ever had. `chats.script_overlay` is kept, unread (see the
-- schema), so this can be rerun by hand against it.
INSERT INTO "plot_reader_overlays" ("user_id", "plot_id", "overlay", "updated_at")
SELECT DISTINCT ON ("user_id", "plot_id") "user_id", "plot_id", "script_overlay", "updated_at"
FROM "chats"
WHERE "script_overlay" IS NOT NULL
ORDER BY "user_id", "plot_id", "updated_at" DESC, "id" DESC
ON CONFLICT ("user_id", "plot_id") DO NOTHING;
