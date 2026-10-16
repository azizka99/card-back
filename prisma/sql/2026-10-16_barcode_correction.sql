-- History of barcode corrections (pack check / activation retry) and the activation sent for each.
-- New table only; nothing existing is touched. Run BEFORE deploying the code that uses it.

CREATE TABLE IF NOT EXISTS "barcode_correction" (
    "id" UUID NOT NULL,
    "steam_card_id" UUID NOT NULL,
    "old_barcode" TEXT NOT NULL,
    "new_barcode" TEXT NOT NULL,
    "pack_id" UUID,
    "source" TEXT NOT NULL,
    "activation_item_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "barcode_correction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "barcode_correction_created_at_idx" ON "barcode_correction" ("created_at");
CREATE INDEX IF NOT EXISTS "barcode_correction_steam_card_id_idx" ON "barcode_correction" ("steam_card_id");
CREATE INDEX IF NOT EXISTS "barcode_correction_old_barcode_idx" ON "barcode_correction" ("old_barcode");
CREATE INDEX IF NOT EXISTS "barcode_correction_new_barcode_idx" ON "barcode_correction" ("new_barcode");
