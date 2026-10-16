-- State the API instances share, in Postgres only (owner's decision, 2026-10-16):
-- the request rate limits' fixed windows, and short leases for exclusivity across
-- instances (one card or module import at a time per reader).
CREATE TABLE "leases" (
	"key" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limits_window_start_idx" ON "rate_limits" USING btree ("window_start");