-- Korean aliases the auxiliary model writes for the lore entries of a book whose keys
-- a Korean reader never types (ARCHITECTURE §7.9): derived data, kept apart from the
-- lorebooks so no export, editor or card carries it, keyed by a hash of each entry's
-- keys and content. And a long lore entry embedded in pieces (`loreChunks`): the lore
-- vector tables gain a chunk index, and an entry's existing row becomes its piece 0.
-- The column comes before the keys that name it (drizzle-kit wrote them the other way).
CREATE TABLE "lore_entry_aliases" (
	"plot_id" uuid NOT NULL,
	"source_hash" text NOT NULL,
	"language" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lore_entry_aliases_plot_id_source_hash_language_pk" PRIMARY KEY("plot_id","source_hash","language")
);
--> statement-breakpoint
ALTER TABLE "lore_entry_vectors" ADD COLUMN "chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reader_lore_vectors" ADD COLUMN "chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lore_entry_vectors" DROP CONSTRAINT "lore_entry_vectors_plot_id_content_hash_pk";--> statement-breakpoint
ALTER TABLE "reader_lore_vectors" DROP CONSTRAINT "reader_lore_vectors_user_id_plot_id_content_hash_pk";--> statement-breakpoint
ALTER TABLE "lore_entry_vectors" ADD CONSTRAINT "lore_entry_vectors_plot_id_content_hash_chunk_index_pk" PRIMARY KEY("plot_id","content_hash","chunk_index");--> statement-breakpoint
ALTER TABLE "reader_lore_vectors" ADD CONSTRAINT "reader_lore_vectors_user_id_plot_id_content_hash_chunk_index_pk" PRIMARY KEY("user_id","plot_id","content_hash","chunk_index");--> statement-breakpoint
ALTER TABLE "lore_entry_aliases" ADD CONSTRAINT "lore_entry_aliases_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;