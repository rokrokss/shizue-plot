-- The lore budget became automatic (a share of the chat's context budget) when a
-- card names none. Every card without its own `token_budget` was stored with the
-- old fixed default of 2048; that number is dropped so the card follows the
-- automatic budget. A card that carried 2048 itself keeps it. `#>>` is SQL NULL
-- for a missing path and for a JSON null alike, and for a null `raw`. Running it
-- again finds nothing left to change.
UPDATE "characters"
SET "card" = "card" #- '{loreSettings,tokenBudget}'
WHERE "card" #> '{loreSettings,tokenBudget}' = '2048'::jsonb
  AND "card" #>> '{raw,data,character_book,token_budget}' IS NULL;
