-- AlterTable
ALTER TABLE "historical_cases" ADD COLUMN     "concepts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
