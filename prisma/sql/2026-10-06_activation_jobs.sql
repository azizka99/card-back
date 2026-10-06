-- Activation jobs: run once against the DB (matches prisma/schema.prisma)

CREATE TABLE "activation_job" (
    "id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "ean" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT '978',
    "status" TEXT NOT NULL,
    "finish_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    CONSTRAINT "activation_job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activation_item" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "steam_card_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "barcode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ean" TEXT,
    "amount" INTEGER,
    "terminal_id" TEXT,
    "tx_id" TEXT,
    "result_text" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_response" JSONB,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activation_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "activation_job_tag_id_created_at_idx" ON "activation_job"("tag_id", "created_at");
CREATE INDEX "activation_item_job_id_status_position_idx" ON "activation_item"("job_id", "status", "position");
CREATE INDEX "activation_item_steam_card_id_idx" ON "activation_item"("steam_card_id");

ALTER TABLE "activation_job" ADD CONSTRAINT "activation_job_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tag"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "activation_item" ADD CONSTRAINT "activation_item_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "activation_job"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
