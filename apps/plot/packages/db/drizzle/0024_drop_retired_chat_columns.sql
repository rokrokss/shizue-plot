-- The two chat columns retired before launch go: `memory`, the rolling summary
-- 0011 moved into `chat_summaries`, and `script_overlay`, the per-chat rewrites
-- 0007 moved into `plot_reader_overlays`. Nothing has read or written either since.
ALTER TABLE "chats" DROP COLUMN "memory";--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "script_overlay";
