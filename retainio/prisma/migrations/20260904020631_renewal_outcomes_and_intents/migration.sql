-- CreateEnum
CREATE TYPE "RenewalOutcome" AS ENUM ('renewed', 'upgraded', 'downgraded', 'left');

-- CreateEnum
CREATE TYPE "IntentKind" AS ENUM ('renewing', 'upgrading', 'downgrading', 'churning');

-- CreateEnum
CREATE TYPE "IntentSource" AS ENUM ('manual', 'email');

-- CreateTable
CREATE TABLE "renewal_intents" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "kind" "IntentKind" NOT NULL,
    "target_tier" "PlanTier",
    "effective_for" TIMESTAMP(3) NOT NULL,
    "source" "IntentSource" NOT NULL DEFAULT 'manual',
    "recorded_by" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "renewal_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_records" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "renewal_date" DATE NOT NULL,
    "outcome" "RenewalOutcome" NOT NULL,
    "retained" BOOLEAN NOT NULL,
    "notes" TEXT,
    "auto_recorded" BOOLEAN NOT NULL DEFAULT false,
    "intent_id" TEXT,
    "recorded_by" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "feature_snapshot" JSONB NOT NULL,
    "predicted_risk" DOUBLE PRECISION,
    "discount_pct" INTEGER NOT NULL DEFAULT 0,
    "discount_months" INTEGER NOT NULL DEFAULT 0,
    "plan_tier_before" "PlanTier" NOT NULL,
    "plan_tier_after" "PlanTier" NOT NULL,

    CONSTRAINT "renewal_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "renewal_intents_account_id_effective_for_idx" ON "renewal_intents"("account_id", "effective_for");

-- CreateIndex
CREATE UNIQUE INDEX "renewal_records_account_id_renewal_date_key" ON "renewal_records"("account_id", "renewal_date");

-- AddForeignKey
ALTER TABLE "renewal_intents" ADD CONSTRAINT "renewal_intents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_intents" ADD CONSTRAINT "renewal_intents_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_records" ADD CONSTRAINT "renewal_records_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_records" ADD CONSTRAINT "renewal_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
