CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"base_url" text,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "model_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"endpoint" text,
	"model" text DEFAULT '' NOT NULL,
	"credential_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "model_binding" jsonb;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "model_binding" jsonb;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_presets" ADD CONSTRAINT "model_presets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_presets" ADD CONSTRAINT "model_presets_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credentials_user_id_idx" ON "credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_one_chatgpt_idx" ON "credentials" USING btree ("user_id") WHERE "credentials"."kind" = 'chatgpt';--> statement-breakpoint
CREATE INDEX "model_presets_user_id_idx" ON "model_presets" USING btree ("user_id","created_at");--> statement-breakpoint
-- ==== Wave 3b data migration (hand-written; keep it last, before the DROPs) ====
-- What `account` and the chats' `model`, `sub_model` and `reasoning_effort` held,
-- moved into `credentials`, `model_presets` and the bindings before the drizzle-kit
-- statements below drop them. A no-op on an empty database.
--
-- 1. The ChatGPT connection: each owner's `account` row of provider `chatgpt`
--    becomes their `credentials` row of kind `chatgpt` — the three tokens copied
--    sealed as they are (the same cipher opens them), the account's `sub`, the
--    registration OpenAI issued and the scope kept, the token's expiry moved. A
--    disconnected row (tokens null) keeps its registration.
INSERT INTO "credentials" ("user_id", "kind", "provider", "label", "secrets", "meta", "expires_at", "created_at", "updated_at")
SELECT DISTINCT ON (a."user_id") a."user_id", 'chatgpt', 'chatgpt', 'ChatGPT',
  jsonb_strip_nulls(jsonb_build_object('accessToken', a."access_token", 'refreshToken', a."refresh_token", 'idToken', a."id_token")),
  jsonb_strip_nulls(jsonb_build_object('subject', a."account_id", 'clientId', a."client_id", 'scope', a."scope")),
  a."access_token_expires_at", a."created_at", a."updated_at"
FROM "account" a
WHERE a."provider_id" = 'chatgpt'
ORDER BY a."user_id", a."updated_at" DESC;--> statement-breakpoint
-- 2. An owner with chats but no ChatGPT row gets a disconnected one, so the
--    presets below have the connection to wait on; connecting fills it.
INSERT INTO "credentials" ("user_id", "kind", "provider", "label")
SELECT DISTINCT c."user_id", 'chatgpt', 'chatgpt', 'ChatGPT'
FROM "chats" c
WHERE NOT EXISTS (SELECT 1 FROM "credentials" x WHERE x."user_id" = c."user_id" AND x."kind" = 'chatgpt');--> statement-breakpoint
-- 3. A model preset for every model the chats ran on — the Responses format over
--    the ChatGPT connection — one per model and reasoning effort, the auxiliary
--    models' with none.
INSERT INTO "model_presets" ("user_id", "name", "format", "model", "credential_id", "params")
SELECT u."user_id",
  u."model" || CASE WHEN u."effort" IS NULL THEN '' ELSE ' · ' || u."effort" END,
  'openai-responses', u."model",
  (SELECT x."id" FROM "credentials" x WHERE x."user_id" = u."user_id" AND x."kind" = 'chatgpt'),
  CASE WHEN u."effort" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reasoningEffort', u."effort") END
FROM (
  SELECT "user_id", "model", "reasoning_effort" AS "effort" FROM "chats"
  UNION
  SELECT "user_id", "sub_model", NULL FROM "chats" WHERE "sub_model" IS NOT NULL
) u
WHERE u."model" <> '';--> statement-breakpoint
-- 4. Each chat bound to the preset of its model and effort, and of its auxiliary model.
UPDATE "chats" SET "model_binding" = NULLIF(jsonb_strip_nulls(jsonb_build_object(
  'main', (SELECT p."id" FROM "model_presets" p
    WHERE p."user_id" = "chats"."user_id" AND p."model" = "chats"."model"
      AND p."params"->>'reasoningEffort' IS NOT DISTINCT FROM "chats"."reasoning_effort" LIMIT 1),
  'sub', (SELECT p."id" FROM "model_presets" p
    WHERE p."user_id" = "chats"."user_id" AND p."model" = "chats"."sub_model"
      AND p."params"->>'reasoningEffort' IS NULL LIMIT 1)
)), '{}'::jsonb);--> statement-breakpoint
-- 5. The owner's default binding: the main model of the chat they used last.
UPDATE "user" SET "model_binding" = (
  SELECT jsonb_build_object('main', c."model_binding"->'main') FROM "chats" c
  WHERE c."user_id" = "user"."id" AND c."model_binding"->>'main' IS NOT NULL
  ORDER BY c."updated_at" DESC LIMIT 1
);--> statement-breakpoint
-- ==== End of the data migration; drizzle-kit's DROPs follow ====
DROP TABLE "account" CASCADE;--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "sub_model";--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "reasoning_effort";
