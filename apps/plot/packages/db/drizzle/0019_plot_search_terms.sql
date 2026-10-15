-- Explore's search by words beside its search by meaning: each public plot's
-- searchable text as the app's terms (character bigrams), BM25 over a GIN index.
-- Null on the rows already there; the next refresh of each fills them.
ALTER TABLE "plot_search_vectors" ADD COLUMN "terms" tsvector;--> statement-breakpoint
ALTER TABLE "plot_search_vectors" ADD COLUMN "term_count" integer;--> statement-breakpoint
CREATE INDEX "plot_search_vectors_terms_idx" ON "plot_search_vectors" USING gin ("terms");
