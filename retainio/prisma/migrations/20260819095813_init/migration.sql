-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('account_manager', 'account_director');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('Basic', 'Pro', 'Enterprise');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'renewed', 'churned', 'cancelled');

-- CreateEnum
CREATE TYPE "LoginFrequency" AS ENUM ('Daily', 'Weekly', 'Rarely');

-- CreateEnum
CREATE TYPE "DiscountStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "title" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "max_self_approval_limit" INTEGER NOT NULL,
    "requires_facial_verification" BOOLEAN NOT NULL,
    "avatar_initials" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_initials" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "account_manager_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "plan_tier" "PlanTier" NOT NULL,
    "mrr" DECIMAL(12,2) NOT NULL,
    "term_start" TIMESTAMP(3) NOT NULL,
    "term_end" TIMESTAMP(3) NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_snapshots" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account_age_days" INTEGER NOT NULL,
    "daily_usage_mins" INTEGER NOT NULL,
    "login_frequency_bucket" "LoginFrequency" NOT NULL,
    "support_tickets_90days" INTEGER NOT NULL,
    "api_utilization_rate" DOUBLE PRECISION NOT NULL,
    "support_ticket_friction" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "usage_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_pct" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "manager_note" TEXT,
    "director_note" TEXT,
    "status" "DiscountStatus" NOT NULL DEFAULT 'pending',
    "risk_score" INTEGER NOT NULL,
    "facial_verification_required" BOOLEAN NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "discount_applied" INTEGER NOT NULL,
    "approver_id" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL,
    "verification_snapshot_url" TEXT,
    "details" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_account_manager_id_fkey" FOREIGN KEY ("account_manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
