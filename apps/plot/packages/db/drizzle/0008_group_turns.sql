ALTER TABLE "characters" ADD COLUMN "talkativeness" smallint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "speaker_member_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "group_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN "group_settings" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_speaker_member_id_characters_id_fk" FOREIGN KEY ("speaker_member_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_speaker_member_id_idx" ON "messages" USING btree ("speaker_member_id") WHERE "messages"."speaker_member_id" is not null;