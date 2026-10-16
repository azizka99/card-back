-- Pack checks read the 200 cards of a pack (steam_card.pack_id); without this index that scans all ~1M cards.
-- CONCURRENTLY: no table lock, scanning keeps working. Run on its own (not inside a transaction).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "steam_card_pack_id_idx" ON "steam_card" ("pack_id");
