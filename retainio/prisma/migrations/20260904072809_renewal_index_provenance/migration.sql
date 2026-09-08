-- AlterTable
ALTER TABLE "renewal_records" ADD COLUMN     "days_to_renewal_at_index" INTEGER,
ADD COLUMN     "features_frozen_at" TIMESTAMP(3);
