-- The product's unit is a plot, not a story. Tables, columns and every index and
-- constraint whose name carried the old word are renamed in place, so data and
-- foreign keys are kept and the result matches a fresh install of the schema.
-- Hand-written: drizzle-kit asks interactively whether a table was renamed.
ALTER TABLE "stories" RENAME TO "plots";--> statement-breakpoint
ALTER TABLE "story_assets" RENAME TO "plot_assets";--> statement-breakpoint
ALTER TABLE "story_likes" RENAME TO "plot_likes";--> statement-breakpoint
ALTER TABLE "characters" RENAME COLUMN "story_id" TO "plot_id";--> statement-breakpoint
ALTER TABLE "chats" RENAME COLUMN "story_id" TO "plot_id";--> statement-breakpoint
ALTER TABLE "comments" RENAME COLUMN "story_id" TO "plot_id";--> statement-breakpoint
ALTER TABLE "memories" RENAME COLUMN "story_id" TO "plot_id";--> statement-breakpoint
ALTER TABLE "notifications" RENAME COLUMN "story_id" TO "plot_id";--> statement-breakpoint
ALTER TABLE "plot_assets" RENAME COLUMN "story_id" TO "plot_id";--> statement-breakpoint
ALTER TABLE "plot_likes" RENAME COLUMN "story_id" TO "plot_id";--> statement-breakpoint
ALTER TABLE "plots" RENAME CONSTRAINT "stories_pkey" TO "plots_pkey";--> statement-breakpoint
ALTER TABLE "plot_assets" RENAME CONSTRAINT "story_assets_pkey" TO "plot_assets_pkey";--> statement-breakpoint
ALTER TABLE "plot_likes" RENAME CONSTRAINT "story_likes_user_id_story_id_pk" TO "plot_likes_user_id_plot_id_pk";--> statement-breakpoint
ALTER TABLE "notifications" RENAME CONSTRAINT "notifications_user_id_story_id_kind_key" TO "notifications_user_id_plot_id_kind_key";--> statement-breakpoint
ALTER TABLE "plot_assets" RENAME CONSTRAINT "story_assets_story_id_slug_key" TO "plot_assets_plot_id_slug_key";--> statement-breakpoint
ALTER TABLE "characters" RENAME CONSTRAINT "characters_story_id_stories_id_fk" TO "characters_plot_id_plots_id_fk";--> statement-breakpoint
ALTER TABLE "chat_asset_unlocks" RENAME CONSTRAINT "chat_asset_unlocks_asset_id_story_assets_id_fk" TO "chat_asset_unlocks_asset_id_plot_assets_id_fk";--> statement-breakpoint
ALTER TABLE "chats" RENAME CONSTRAINT "chats_story_id_stories_id_fk" TO "chats_plot_id_plots_id_fk";--> statement-breakpoint
ALTER TABLE "comments" RENAME CONSTRAINT "comments_story_id_stories_id_fk" TO "comments_plot_id_plots_id_fk";--> statement-breakpoint
ALTER TABLE "memories" RENAME CONSTRAINT "memories_story_id_stories_id_fk" TO "memories_plot_id_plots_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" RENAME CONSTRAINT "notifications_story_id_stories_id_fk" TO "notifications_plot_id_plots_id_fk";--> statement-breakpoint
ALTER TABLE "plots" RENAME CONSTRAINT "stories_owner_id_user_id_fk" TO "plots_owner_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "plot_assets" RENAME CONSTRAINT "story_assets_story_id_stories_id_fk" TO "plot_assets_plot_id_plots_id_fk";--> statement-breakpoint
ALTER TABLE "plot_likes" RENAME CONSTRAINT "story_likes_user_id_user_id_fk" TO "plot_likes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "plot_likes" RENAME CONSTRAINT "story_likes_story_id_stories_id_fk" TO "plot_likes_plot_id_plots_id_fk";--> statement-breakpoint
ALTER INDEX "characters_story_id_idx" RENAME TO "characters_plot_id_idx";--> statement-breakpoint
ALTER INDEX "chats_story_id_idx" RENAME TO "chats_plot_id_idx";--> statement-breakpoint
ALTER INDEX "comments_story_id_idx" RENAME TO "comments_plot_id_idx";--> statement-breakpoint
ALTER INDEX "stories_explore_recent_idx" RENAME TO "plots_explore_recent_idx";--> statement-breakpoint
ALTER INDEX "stories_explore_likes_idx" RENAME TO "plots_explore_likes_idx";--> statement-breakpoint
ALTER INDEX "stories_explore_chats_idx" RENAME TO "plots_explore_chats_idx";--> statement-breakpoint
ALTER INDEX "stories_tags_idx" RENAME TO "plots_tags_idx";--> statement-breakpoint
ALTER INDEX "story_likes_story_id_idx" RENAME TO "plot_likes_plot_id_idx";--> statement-breakpoint
-- Stored values that named the old unit: the notification kind, and pending
-- fan-out jobs, whose payload the worker reads by the new names.
UPDATE "notifications" SET "kind" = 'plot_published' WHERE "kind" = 'story_published';--> statement-breakpoint
UPDATE "jobs" SET "payload" = ("payload" - 'storyId' - 'kind')
  || jsonb_build_object('plotId', "payload"->'storyId', 'kind', 'plot_published')
  WHERE "kind" = 'notification_fanout' AND "payload" ? 'storyId';
