-- Renames the support-ticket tables to reflect what they actually hold: customer
-- reviews, not support requests. Written as RENAMEs rather than the drop-and-create
-- Prisma infers from a model rename, which would have destroyed every review and
-- orphaned the sentiment predictions pointing at them.
--
-- UsageSnapshot.support_tickets_90days is deliberately untouched: that is a COUNT of
-- support contacts, genuinely tickets, and a trained churn-model feature.
ALTER TABLE "support_tickets" RENAME TO "customer_reviews";
ALTER TABLE "customer_reviews" RENAME COLUMN "body" TO "review_text";
ALTER TABLE "customer_reviews" RENAME COLUMN "opened_at" TO "submitted_at";
ALTER TABLE "sentiment_predictions" RENAME COLUMN "support_ticket_id" TO "review_id";
