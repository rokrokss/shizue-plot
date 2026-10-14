CREATE TABLE "lore_entry_vectors" (
	"plot_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	CONSTRAINT "lore_entry_vectors_plot_id_content_hash_pk" PRIMARY KEY("plot_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "message_chunks" (
	"message_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	CONSTRAINT "message_chunks_message_id_chunk_index_pk" PRIMARY KEY("message_id","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "retrieval" jsonb;--> statement-breakpoint
ALTER TABLE "lore_entry_vectors" ADD CONSTRAINT "lore_entry_vectors_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;