-- Facts that stop holding are kept rather than deleted: the summary whose messages
-- ended one, its last turn, and the fact that took its place. Summaries and facts
-- keep the turns they cover. Null on the rows already there: nothing has ended
-- yet, and the memory reads a summary's turns off the branch it applies to.
ALTER TABLE "chat_summaries" ADD COLUMN "turn_from" integer;--> statement-breakpoint
ALTER TABLE "chat_summaries" ADD COLUMN "turn_to" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "turn_from" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "turn_to" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "invalidated_by_summary_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "invalidated_turn" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_invalidated_by_summary_id_chat_summaries_id_fk" FOREIGN KEY ("invalidated_by_summary_id") REFERENCES "public"."chat_summaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_id_memories_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_invalidated_by_idx" ON "memories" USING btree ("invalidated_by_summary_id") WHERE "memories"."invalidated_by_summary_id" is not null;--> statement-breakpoint
CREATE INDEX "memories_superseded_by_idx" ON "memories" USING btree ("superseded_by_id") WHERE "memories"."superseded_by_id" is not null;