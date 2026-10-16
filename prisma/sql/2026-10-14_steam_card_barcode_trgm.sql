-- Fast partial barcode search (admin search page: "contains" / LIKE '%…%').
-- Without it every partial search reads all ~1M steam_card rows (1-2 s).
-- CONCURRENTLY: no table lock, scanning keeps working. Run each statement on its own (not inside a transaction).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "steam_card_barcode_trgm_idx" ON "steam_card" USING gin ("barcode" gin_trgm_ops);
