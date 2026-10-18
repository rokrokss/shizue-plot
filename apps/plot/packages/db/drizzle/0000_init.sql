CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"model_binding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plot_id" uuid NOT NULL,
	"name" text NOT NULL,
	"card" jsonb NOT NULL,
	"imported_from" jsonb,
	"avatar_path" text,
	"order_index" integer DEFAULT 0 NOT NULL,
	"talkativeness" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"thumbhash" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_note_links" (
	"chat_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	CONSTRAINT "chat_note_links_chat_id_note_id_pk" PRIMARY KEY("chat_id","note_id")
);
--> statement-breakpoint
CREATE TABLE "chat_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"text" text NOT NULL,
	"message_ids" uuid[] NOT NULL,
	"important" boolean DEFAULT false NOT NULL,
	"turn_from" integer,
	"turn_to" integer,
	"scene_member_ids" uuid[],
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
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"plot_id" uuid NOT NULL,
	"persona_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"model_binding" jsonb,
	"note" text DEFAULT '' NOT NULL,
	"note_settings" jsonb,
	"translation" jsonb,
	"retrieval" jsonb,
	"preset" text DEFAULT 'default' NOT NULL,
	"reader_preset_id" uuid,
	"head_message_id" uuid,
	"memory_settings" jsonb,
	"memory_revision" integer DEFAULT 0 NOT NULL,
	"emotion_processor" text,
	"narrator" jsonb,
	"allow_component_turns" boolean DEFAULT false NOT NULL,
	"status_window_enabled" boolean DEFAULT true NOT NULL,
	"choices_enabled" boolean DEFAULT true NOT NULL,
	"absent_character_ids" jsonb,
	"imported_from" jsonb,
	"importing" boolean DEFAULT false NOT NULL,
	"local_lore" jsonb,
	"modules" jsonb,
	"local_toggles" boolean DEFAULT false NOT NULL,
	"local_global_variables" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_import_keys" (
	"import_id" uuid NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "file_import_keys_import_id_key_pk" PRIMARY KEY("import_id","key")
);
--> statement-breakpoint
CREATE TABLE "file_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"target" text NOT NULL,
	"plot_id" uuid,
	"file_name" text NOT NULL,
	"size" bigint NOT NULL,
	"part_size" integer NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"upload_id" text,
	"staged" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"stage" text,
	"progress" jsonb,
	"result" jsonb,
	"error" jsonb,
	"written" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"plot_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"summary_id" uuid NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"embedding" vector,
	"turn_from" integer,
	"turn_to" integer,
	"invalidated_by_summary_id" uuid,
	"invalidated_turn" integer,
	"superseded_by_id" uuid,
	"scene_member_ids" uuid[],
	"known_to_all" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "message_translations" (
	"message_id" uuid NOT NULL,
	"language" text NOT NULL,
	"content_hash" text NOT NULL,
	"texts" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_translations_message_id_language_pk" PRIMARY KEY("message_id","language")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"directions" text,
	"lore_triggers" jsonb,
	"variable_delta" jsonb,
	"script_state" text,
	"script_rev" integer DEFAULT 0 NOT NULL,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"speaker_member_id" uuid,
	"group_turn_id" uuid,
	"hidden_from_prompt" boolean DEFAULT false NOT NULL,
	"emotion" text,
	"display_text" text,
	"reasoning" text,
	"bias" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"avatar_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plot_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plot_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"thumbhash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plot_assets_plot_id_slug_key" UNIQUE("plot_id","slug")
);
--> statement-breakpoint
CREATE TABLE "plot_reader_variables" (
	"plot_id" uuid PRIMARY KEY NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cover_path" text,
	"lorebook" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intros" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"narrator" jsonb,
	"style" jsonb,
	"profiles" jsonb,
	"custom_ui" jsonb,
	"group_settings" jsonb,
	"language" text DEFAULT 'ko' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reader_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"module" jsonb NOT NULL,
	"assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_globally" boolean DEFAULT false NOT NULL,
	"plot_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reader_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"main" text DEFAULT '' NOT NULL,
	"global_note" text DEFAULT '' NOT NULL,
	"jailbreak" text DEFAULT '' NOT NULL,
	"formating_order" jsonb,
	"prompt_template" jsonb,
	"group_template" text DEFAULT '' NOT NULL,
	"group_other_bot_role" text DEFAULT 'user' NOT NULL,
	"toggles" text DEFAULT '' NOT NULL,
	"module_integration" text DEFAULT '' NOT NULL,
	"default_variables" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
);
--> statement-breakpoint
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
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_note_links" ADD CONSTRAINT "chat_note_links_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_note_links" ADD CONSTRAINT "chat_note_links_note_id_user_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."user_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_summaries" ADD CONSTRAINT "chat_summaries_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_summary_chunks" ADD CONSTRAINT "chat_summary_chunks_summary_id_chat_summaries_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."chat_summaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_reader_preset_id_reader_presets_id_fk" FOREIGN KEY ("reader_preset_id") REFERENCES "public"."reader_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_import_keys" ADD CONSTRAINT "file_import_keys_import_id_file_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."file_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_entry_aliases" ADD CONSTRAINT "lore_entry_aliases_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_summary_id_chat_summaries_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."chat_summaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_invalidated_by_summary_id_chat_summaries_id_fk" FOREIGN KEY ("invalidated_by_summary_id") REFERENCES "public"."chat_summaries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_id_memories_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translations" ADD CONSTRAINT "message_translations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_speaker_member_id_characters_id_fk" FOREIGN KEY ("speaker_member_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plot_assets" ADD CONSTRAINT "plot_assets_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plot_reader_variables" ADD CONSTRAINT "plot_reader_variables_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_modules" ADD CONSTRAINT "reader_modules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_presets" ADD CONSTRAINT "reader_presets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_presets" ADD CONSTRAINT "model_presets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_presets" ADD CONSTRAINT "model_presets_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_plot_id_idx" ON "characters" USING btree ("plot_id","order_index");--> statement-breakpoint
CREATE INDEX "chat_attachments_chat_id_idx" ON "chat_attachments" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chat_attachments_message_id_idx" ON "chat_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_summaries_chat_id_idx" ON "chat_summaries" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chats_user_id_idx" ON "chats" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chats_plot_id_idx" ON "chats" USING btree ("plot_id");--> statement-breakpoint
CREATE INDEX "file_imports_user_id_idx" ON "file_imports" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "file_imports_status_idx" ON "file_imports" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "memories_chat_id_idx" ON "memories" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "memories_summary_id_idx" ON "memories" USING btree ("summary_id");--> statement-breakpoint
CREATE INDEX "memories_invalidated_by_idx" ON "memories" USING btree ("invalidated_by_summary_id") WHERE "memories"."invalidated_by_summary_id" is not null;--> statement-breakpoint
CREATE INDEX "memories_superseded_by_idx" ON "memories" USING btree ("superseded_by_id") WHERE "memories"."superseded_by_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_chat_id_idx" ON "messages" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "messages_parent_id_idx" ON "messages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "messages_speaker_member_id_idx" ON "messages" USING btree ("speaker_member_id") WHERE "messages"."speaker_member_id" is not null;--> statement-breakpoint
CREATE INDEX "reader_modules_user_id_idx" ON "reader_modules" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reader_presets_user_id_idx" ON "reader_presets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_notes_user_id_idx" ON "user_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credentials_user_id_idx" ON "credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_one_chatgpt_idx" ON "credentials" USING btree ("user_id") WHERE "credentials"."kind" = 'chatgpt';--> statement-breakpoint
CREATE INDEX "model_presets_user_id_idx" ON "model_presets" USING btree ("user_id","created_at");