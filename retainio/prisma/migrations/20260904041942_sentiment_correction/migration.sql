-- AlterTable
ALTER TABLE "customer_reviews" ADD COLUMN     "corrected_at" TIMESTAMP(3),
ADD COLUMN     "corrected_by" TEXT,
ADD COLUMN     "corrected_sentiment" "SentimentClass";

-- AddForeignKey
ALTER TABLE "customer_reviews" ADD CONSTRAINT "customer_reviews_corrected_by_fkey" FOREIGN KEY ("corrected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
