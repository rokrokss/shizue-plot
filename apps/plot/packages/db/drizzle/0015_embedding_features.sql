-- The facts the rolling summary extracted before HypaV3 (0011): unread since,
-- tied to its anchor rule, which is gone, and embedded by a model nothing runs
-- (1536 dimensions, no model id). They were a derived cache; each summary's own
-- extraction writes the facts again from here on.
DELETE FROM "memories";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "source_message_id";--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "embedding" SET DATA TYPE vector;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "summary_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_summary_id_chat_summaries_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."chat_summaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_summary_id_idx" ON "memories" USING btree ("summary_id");--> statement-breakpoint
CREATE TABLE "plot_search_vectors" (
	"plot_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	"text_hash" text NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plot_search_vectors" ADD CONSTRAINT "plot_search_vectors_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "emotion_processor" text;
