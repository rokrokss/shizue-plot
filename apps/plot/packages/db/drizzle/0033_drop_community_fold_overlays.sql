-- A personal app (2026-10-18): what a card's scripts rewrote of a work for its
-- owner (`plot_reader_overlays`) is folded into the work itself, as RisuAI's
-- scripts rewrite the character, before the table goes. Only the work's own
-- owner's rewrites are kept; the community tables, the rate limits, the
-- leases and the generation claim go after.
DELETE FROM "jobs" WHERE "kind" = 'notification_fanout';--> statement-breakpoint
UPDATE "characters" AS c SET
  "name" = CASE WHEN jsonb_typeof(r.fields->'name') = 'string' THEN r.fields->>'name' ELSE c."name" END,
  "card" = c."card"
    || CASE WHEN jsonb_typeof(r.fields->'name') = 'string' THEN jsonb_build_object('name', r.fields->'name') ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(r.fields->'description') = 'string' THEN jsonb_build_object('description', r.fields->'description') ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(r.fields->'lorebook') = 'array' THEN jsonb_build_object('lorebook', r.fields->'lorebook') ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(r.fields->'postHistoryInstructions') = 'string' THEN jsonb_build_object('postHistoryInstructions', r.fields->'postHistoryInstructions') ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(r.fields->'backgroundHtml') = 'string' THEN jsonb_build_object('extensions',
         CASE WHEN jsonb_typeof(c."card"->'extensions') = 'object' THEN c."card"->'extensions' ELSE '{}'::jsonb END
         || jsonb_build_object('risuai',
           CASE WHEN jsonb_typeof(c."card"->'extensions'->'risuai') = 'object' THEN c."card"->'extensions'->'risuai' ELSE '{}'::jsonb END
           || jsonb_build_object('backgroundHTML', r.fields->'backgroundHtml')))
       ELSE '{}'::jsonb END,
  "updated_at" = now()
FROM (
  SELECT o."plot_id", m.key AS member_id, m.value AS fields
  FROM "plot_reader_overlays" AS o
  JOIN "plots" AS p ON p."id" = o."plot_id" AND p."owner_id" = o."user_id"
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o."overlay"->'members') = 'object' THEN o."overlay"->'members' ELSE '{}'::jsonb END) AS m(key, value)
  WHERE jsonb_typeof(m.value) = 'object'
) AS r
WHERE c."id"::text = r.member_id AND c."plot_id" = r."plot_id";--> statement-breakpoint
-- A work of one member is that character: its name follows the rename.
UPDATE "plots" AS p SET "name" = c."name", "updated_at" = now()
FROM "characters" AS c, "plot_reader_overlays" AS o
WHERE c."plot_id" = p."id" AND o."plot_id" = p."id" AND o."user_id" = p."owner_id"
  AND jsonb_typeof(o."overlay"->'members'->(c."id"::text)->'name') = 'string'
  AND (SELECT count(*) FROM "characters" AS m WHERE m."plot_id" = p."id") = 1;--> statement-breakpoint
-- The background the work draws, and its first opening, from the first member
-- (in the roster's order) whose scripts rewrote them.
UPDATE "plots" AS p SET
  "custom_ui" = CASE WHEN jsonb_typeof(p."custom_ui") = 'object' THEN p."custom_ui" ELSE '{}'::jsonb END || jsonb_build_object('backgroundHtml', b.html),
  "updated_at" = now()
FROM (
  SELECT DISTINCT ON (o."plot_id") o."plot_id", m.value->'backgroundHtml' AS html
  FROM "plot_reader_overlays" AS o
  JOIN "plots" AS p2 ON p2."id" = o."plot_id" AND p2."owner_id" = o."user_id"
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o."overlay"->'members') = 'object' THEN o."overlay"->'members' ELSE '{}'::jsonb END) AS m(key, value)
  JOIN "characters" AS c ON c."id"::text = m.key AND c."plot_id" = o."plot_id"
  WHERE jsonb_typeof(m.value->'backgroundHtml') = 'string'
  ORDER BY o."plot_id", c."order_index", c."created_at"
) AS b
WHERE p."id" = b."plot_id";--> statement-breakpoint
-- Every chat of the work shows its first opening as rewritten, as RisuAI draws
-- a chat's first greeting from its character: the chat's oldest root, where it
-- is a greeting. Before the work's own opening, which the next statement reads.
UPDATE "messages" AS msg SET "content" = f.message #>> '{}'
FROM (
  SELECT DISTINCT ON (o."plot_id") o."plot_id", m.value->'firstMessage' AS message
  FROM "plot_reader_overlays" AS o
  JOIN "plots" AS p ON p."id" = o."plot_id" AND p."owner_id" = o."user_id"
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o."overlay"->'members') = 'object' THEN o."overlay"->'members' ELSE '{}'::jsonb END) AS m(key, value)
  JOIN "characters" AS c ON c."id"::text = m.key AND c."plot_id" = o."plot_id"
  WHERE jsonb_typeof(m.value->'firstMessage') = 'string'
  ORDER BY o."plot_id", c."order_index", c."created_at"
) AS f,
(
  SELECT DISTINCT ON (m."chat_id") m."id", ch."plot_id"
  FROM "messages" AS m
  JOIN "chats" AS ch ON ch."id" = m."chat_id"
  JOIN "plots" AS p ON p."id" = ch."plot_id" AND p."owner_id" = ch."user_id"
  WHERE m."parent_id" IS NULL
  ORDER BY m."chat_id", m."created_at", m."id"
) AS roots
WHERE roots."plot_id" = f."plot_id" AND msg."id" = roots."id" AND msg."role" = 'assistant';--> statement-breakpoint
UPDATE "plots" AS p SET
  "intros" = CASE WHEN jsonb_typeof(p."intros") = 'array' AND jsonb_array_length(p."intros") > 0
    THEN jsonb_set(p."intros", '{0}', f.message) ELSE jsonb_build_array(f.message) END,
  "updated_at" = now()
FROM (
  SELECT DISTINCT ON (o."plot_id") o."plot_id", m.value->'firstMessage' AS message
  FROM "plot_reader_overlays" AS o
  JOIN "plots" AS p2 ON p2."id" = o."plot_id" AND p2."owner_id" = o."user_id"
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o."overlay"->'members') = 'object' THEN o."overlay"->'members' ELSE '{}'::jsonb END) AS m(key, value)
  JOIN "characters" AS c ON c."id"::text = m.key AND c."plot_id" = o."plot_id"
  WHERE jsonb_typeof(m.value->'firstMessage') = 'string'
  ORDER BY o."plot_id", c."order_index", c."created_at"
) AS f
WHERE p."id" = f."plot_id";--> statement-breakpoint
-- The persona as the scripts left it, on the personas the owner's chats on the work use.
UPDATE "personas" AS pe SET "description" = o."overlay"->>'persona'
FROM "plot_reader_overlays" AS o
JOIN "plots" AS p ON p."id" = o."plot_id" AND p."owner_id" = o."user_id"
WHERE jsonb_typeof(o."overlay"->'persona') = 'string'
  AND pe."id" IN (SELECT ch."persona_id" FROM "chats" AS ch WHERE ch."plot_id" = o."plot_id" AND ch."user_id" = o."user_id" AND ch."persona_id" IS NOT NULL);--> statement-breakpoint
-- The global variables become the work's: its owner's values, and no one else's.
DELETE FROM "plot_reader_variables" AS v USING "plots" AS p WHERE v."plot_id" = p."id" AND v."user_id" <> p."owner_id";--> statement-breakpoint
ALTER TABLE "comments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_cursors" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "follows" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plot_likes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plot_reader_overlays" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plot_search_vectors" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limits" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "comments" CASCADE;--> statement-breakpoint
DROP TABLE "feed_cursors" CASCADE;--> statement-breakpoint
DROP TABLE "follows" CASCADE;--> statement-breakpoint
DROP TABLE "leases" CASCADE;--> statement-breakpoint
DROP TABLE "notifications" CASCADE;--> statement-breakpoint
DROP TABLE "plot_likes" CASCADE;--> statement-breakpoint
DROP TABLE "plot_reader_overlays" CASCADE;--> statement-breakpoint
DROP TABLE "plot_search_vectors" CASCADE;--> statement-breakpoint
DROP TABLE "rate_limits" CASCADE;--> statement-breakpoint
ALTER TABLE "plot_reader_variables" DROP CONSTRAINT "plot_reader_variables_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "plots_explore_recent_idx";--> statement-breakpoint
DROP INDEX "plots_explore_likes_idx";--> statement-breakpoint
DROP INDEX "plots_explore_chats_idx";--> statement-breakpoint
DROP INDEX "plots_tags_idx";--> statement-breakpoint
ALTER TABLE "plot_reader_variables" DROP CONSTRAINT "plot_reader_variables_user_id_plot_id_pk";--> statement-breakpoint
ALTER TABLE "plot_reader_variables" ADD PRIMARY KEY ("plot_id");--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "generating_at";--> statement-breakpoint
ALTER TABLE "plot_reader_variables" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "visibility";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "safety_level";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "published_at";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "like_count";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "chat_count";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "comments_enabled";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "rights_confirmed_at";