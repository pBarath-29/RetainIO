-- CreateEnum
CREATE TYPE "EmailIngestStatus" AS ENUM ('ingested', 'unmatched', 'ambiguous', 'empty', 'failed');

-- CreateTable
CREATE TABLE "ingested_emails" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EmailIngestStatus" NOT NULL,
    "account_id" TEXT,
    "review_id" TEXT,
    "note" TEXT,

    CONSTRAINT "ingested_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingested_emails_message_id_key" ON "ingested_emails"("message_id");

-- CreateIndex
CREATE INDEX "ingested_emails_processed_at_idx" ON "ingested_emails"("processed_at");

-- CreateIndex
CREATE INDEX "customer_reviews_account_id_submitted_at_idx" ON "customer_reviews"("account_id", "submitted_at");

-- AddForeignKey
ALTER TABLE "ingested_emails" ADD CONSTRAINT "ingested_emails_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingested_emails" ADD CONSTRAINT "ingested_emails_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "customer_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
