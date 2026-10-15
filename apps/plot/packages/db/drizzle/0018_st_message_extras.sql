-- What SillyTavern keeps beside a message it brings in (`extra`): the text shown in
-- its place (`display_text`), the model's reasoning, and the reader's `{{bias}}`.
ALTER TABLE "messages" ADD COLUMN "display_text" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reasoning" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bias" text;