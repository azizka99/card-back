-- Weekly activation report filters activation_item by updated_at.
-- CONCURRENTLY: no lock; run on its own (not inside a transaction).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activation_item_updated_at_status_idx" ON "activation_item" ("updated_at", "status");
