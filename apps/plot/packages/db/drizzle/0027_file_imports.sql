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
ALTER TABLE "file_import_keys" ADD CONSTRAINT "file_import_keys_import_id_file_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."file_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_imports_user_id_idx" ON "file_imports" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "file_imports_status_idx" ON "file_imports" USING btree ("status","updated_at");