-- Add snapshot_date as nullable first, since fusion_scores already has rows
ALTER TABLE "fusion_scores" ADD COLUMN "snapshot_date" DATE;

-- Backfill snapshot_date from the existing computed_at timestamps
UPDATE "fusion_scores" SET "snapshot_date" = "computed_at"::date WHERE "snapshot_date" IS NULL;

-- Now safe to enforce NOT NULL
ALTER TABLE "fusion_scores" ALTER COLUMN "snapshot_date" SET NOT NULL;

-- One row per account per day from here on
CREATE UNIQUE INDEX "fusion_scores_account_id_snapshot_date_key" ON "fusion_scores"("account_id", "snapshot_date");

-- CreateTable
CREATE TABLE "fusion_monthly_summaries" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "month_start" DATE NOT NULL,
    "avg_fusion_score" DOUBLE PRECISION NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "risk_category" "RiskBand" NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fusion_monthly_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fusion_monthly_summaries_account_id_month_start_key" ON "fusion_monthly_summaries"("account_id", "month_start");

-- AddForeignKey
ALTER TABLE "fusion_monthly_summaries" ADD CONSTRAINT "fusion_monthly_summaries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
