-- Speeds up "latest cards" (dashboard, live feed) and the user -> tags picker on the download page.
-- CONCURRENTLY: no table lock, scanning keeps working. Run each statement on its own (not inside a transaction).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "steam_card_created_at_idx" ON "steam_card" ("created_at" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "steam_card_user_tag_idx" ON "steam_card" ("user_id", "tag_id");
