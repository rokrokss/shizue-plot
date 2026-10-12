CREATE TABLE "plot_reader_variables" (
	"user_id" text NOT NULL,
	"plot_id" uuid NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plot_reader_variables_user_id_plot_id_pk" PRIMARY KEY("user_id","plot_id")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "script_overlay" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "variable_delta" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "script_state" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "script_rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plot_reader_variables" ADD CONSTRAINT "plot_reader_variables_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plot_reader_variables" ADD CONSTRAINT "plot_reader_variables_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;