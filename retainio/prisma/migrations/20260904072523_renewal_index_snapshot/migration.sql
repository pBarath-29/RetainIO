-- CreateEnum
CREATE TYPE "IndexReason" AS ENUM ('window_open', 'offer_approved');

-- CreateTable
CREATE TABLE "renewal_index_snapshots" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "renewal_date" DATE NOT NULL,
    "frozen_at" TIMESTAMP(3) NOT NULL,
    "reason" "IndexReason" NOT NULL,
    "days_to_renewal" INTEGER NOT NULL,
    "feature_snapshot" JSONB NOT NULL,
    "churn_proba" DOUBLE PRECISION,
    "sentiment_score" DOUBLE PRECISION,
    "fused_proba" DOUBLE PRECISION,
    "dominant_shap_driver" TEXT,

    CONSTRAINT "renewal_index_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "renewal_index_snapshots_account_id_renewal_date_key" ON "renewal_index_snapshots"("account_id", "renewal_date");

-- AddForeignKey
ALTER TABLE "renewal_index_snapshots" ADD CONSTRAINT "renewal_index_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
