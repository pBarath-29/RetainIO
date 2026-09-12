-- AlterEnum
ALTER TYPE "DiscountStatus" ADD VALUE 'withdrawn';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "withdrawn_at" TIMESTAMP(3),
ADD COLUMN     "withdrawn_by" TEXT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
