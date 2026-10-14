CREATE TABLE "chat_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"text" text NOT NULL,
	"message_ids" uuid[] NOT NULL,
	"important" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_summary_chunks" (
	"summary_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	CONSTRAINT "chat_summary_chunks_summary_id_chunk_index_pk" PRIMARY KEY("summary_id","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "chat_summaries" ADD CONSTRAINT "chat_summaries_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_summary_chunks" ADD CONSTRAINT "chat_summary_chunks_summary_id_chat_summaries_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."chat_summaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_summaries_chat_id_idx" ON "chat_summaries" USING btree ("chat_id");--> statement-breakpoint
-- The rolling summary each chat kept becomes one HypaV3 summary, not important,
-- covering what it covered: its anchor and every message above it, the ones
-- hidden from the AI left out as the summary left them out. `chats.memory` stays,
-- unread (see the schema), so this can be rerun by hand against it.
INSERT INTO "chat_summaries" ("chat_id", "text", "message_ids", "important", "created_at", "updated_at")
SELECT c."id", btrim(c."memory"->>'summary'), covered."ids", false,
  COALESCE((c."memory"->>'updatedAt')::timestamptz, now()), COALESCE((c."memory"->>'updatedAt')::timestamptz, now())
FROM "chats" c
CROSS JOIN LATERAL (
  WITH RECURSIVE chain ("id", "parent_id", "hidden", "depth") AS (
    SELECT m."id", m."parent_id", m."hidden_from_prompt", 0
    FROM "messages" m
    WHERE m."chat_id" = c."id" AND m."id"::text = c."memory"->>'anchorMessageId'
    UNION ALL
    SELECT p."id", p."parent_id", p."hidden_from_prompt", chain."depth" + 1
    FROM "messages" p JOIN chain ON p."id" = chain."parent_id"
  )
  SELECT array_agg(chain."id" ORDER BY chain."depth" DESC) FILTER (WHERE NOT chain."hidden") AS "ids" FROM chain
) covered
WHERE c."memory" IS NOT NULL
  AND btrim(COALESCE(c."memory"->>'summary', '')) <> ''
  AND covered."ids" IS NOT NULL;--> statement-breakpoint
-- `summaryThreshold` and `retrievalCount` went with the rolling summary and its
-- facts: HypaV3 summarizes when the history no longer fits, and selects rather
-- than retrieves.
UPDATE "chats"
SET "memory_settings" = NULLIF("memory_settings" - 'summaryThreshold' - 'retrievalCount', '{}'::jsonb)
WHERE "memory_settings" IS NOT NULL;