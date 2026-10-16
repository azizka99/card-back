-- Fallback EAN/amount per activation job ("if invalid amount, try this instead").
-- Nullable columns without default: instant, no table rewrite.
-- Run this BEFORE deploying the code that uses it.

ALTER TABLE "activation_job" ADD COLUMN IF NOT EXISTS "fallback_ean" TEXT;
ALTER TABLE "activation_job" ADD COLUMN IF NOT EXISTS "fallback_amount" INTEGER;
