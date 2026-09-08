-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "discount_starts_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "customer_reviews" RENAME CONSTRAINT "support_tickets_pkey" TO "customer_reviews_pkey";

-- AlterTable
ALTER TABLE "discount_requests" ADD COLUMN     "applies_to_renewal" TIMESTAMP(3);

-- RenameForeignKey
ALTER TABLE "customer_reviews" RENAME CONSTRAINT "support_tickets_account_id_fkey" TO "customer_reviews_account_id_fkey";

-- RenameForeignKey
ALTER TABLE "sentiment_predictions" RENAME CONSTRAINT "sentiment_predictions_support_ticket_id_fkey" TO "sentiment_predictions_review_id_fkey";
