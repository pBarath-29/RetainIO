-- CreateEnum
CREATE TYPE "ReviewCategory" AS ENUM ('technical', 'price', 'general');

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "review_category" "ReviewCategory";
