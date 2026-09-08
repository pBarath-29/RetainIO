-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "discount_months" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "discount_requests" ADD COLUMN     "duration_months" INTEGER NOT NULL DEFAULT 12;
