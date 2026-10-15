-- Who a group work's memory belongs to: the members who speak in the batch a
-- summary covers, carried on to the facts taken from it, and whether a fact is one
-- everyone knows. Null members on the rows already there: known to every member.
ALTER TABLE "chat_summaries" ADD COLUMN "scene_member_ids" uuid[];--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "scene_member_ids" uuid[];--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "known_to_all" boolean DEFAULT false NOT NULL;
