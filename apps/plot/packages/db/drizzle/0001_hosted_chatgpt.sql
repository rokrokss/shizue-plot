ALTER TABLE "ledger_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "ledger_entries" CASCADE;--> statement-breakpoint
DROP TABLE "wallets" CASCADE;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_idx" ON "account" USING btree ("provider_id","account_id");