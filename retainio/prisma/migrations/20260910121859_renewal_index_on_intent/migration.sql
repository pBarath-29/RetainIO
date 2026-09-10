-- AlterEnum
ALTER TYPE "IndexReason" ADD VALUE 'intent_recorded';

-- AlterTable
ALTER TABLE "renewal_records" ADD COLUMN     "index_reason" "IndexReason";
