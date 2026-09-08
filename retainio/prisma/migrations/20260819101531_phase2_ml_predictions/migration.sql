-- CreateEnum
CREATE TYPE "ModelFamily" AS ENUM ('churn', 'sentiment', 'fusion', 'uplift');

-- CreateEnum
CREATE TYPE "RiskBand" AS ENUM ('High Risk', 'Medium Risk', 'Low Risk');

-- CreateEnum
CREATE TYPE "SentimentClass" AS ENUM ('Frustrated', 'Neutral', 'Satisfied');

-- CreateEnum
CREATE TYPE "ShapDirection" AS ENUM ('risk_increase', 'risk_decrease');

-- CreateTable
CREATE TABLE "model_versions" (
    "id" TEXT NOT NULL,
    "model_family" "ModelFamily" NOT NULL,
    "algorithm" TEXT NOT NULL,
    "version_tag" TEXT,
    "threshold" DOUBLE PRECISION,
    "trained_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "artifact_path" TEXT NOT NULL,

    CONSTRAINT "model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "churn_predictions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "model_version_id" TEXT,
    "predicted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "churn_proba" DOUBLE PRECISION NOT NULL,
    "predicted_default" BOOLEAN,
    "predicted_tuned" BOOLEAN,
    "risk_band" "RiskBand" NOT NULL,

    CONSTRAINT "churn_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentiment_predictions" (
    "id" TEXT NOT NULL,
    "support_ticket_id" TEXT,
    "model_version_id" TEXT,
    "classification" "SentimentClass" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "text_length" INTEGER,
    "predicted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentiment_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fusion_scores" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "churn_prediction_id" TEXT,
    "sentiment_prediction_id" TEXT,
    "fusion_score" DOUBLE PRECISION NOT NULL,
    "dominant_driver" TEXT,
    "risk_category" "RiskBand" NOT NULL,

    CONSTRAINT "fusion_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shap_explanations" (
    "id" TEXT NOT NULL,
    "churn_prediction_id" TEXT NOT NULL,
    "feature_name" TEXT NOT NULL,
    "impact" DOUBLE PRECISION NOT NULL,
    "direction" "ShapDirection" NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "shap_explanations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_explanations" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "fusion_score_id" TEXT,
    "summary" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,

    CONSTRAINT "ai_explanations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_interventions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "discount_request_id" TEXT,
    "intervention_type" TEXT NOT NULL,
    "discount_pct" INTEGER,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewed" BOOLEAN,
    "outcome_observed_at" TIMESTAMP(3),

    CONSTRAINT "retention_interventions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "churn_predictions" ADD CONSTRAINT "churn_predictions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "churn_predictions" ADD CONSTRAINT "churn_predictions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_predictions" ADD CONSTRAINT "sentiment_predictions_support_ticket_id_fkey" FOREIGN KEY ("support_ticket_id") REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_predictions" ADD CONSTRAINT "sentiment_predictions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fusion_scores" ADD CONSTRAINT "fusion_scores_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fusion_scores" ADD CONSTRAINT "fusion_scores_churn_prediction_id_fkey" FOREIGN KEY ("churn_prediction_id") REFERENCES "churn_predictions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fusion_scores" ADD CONSTRAINT "fusion_scores_sentiment_prediction_id_fkey" FOREIGN KEY ("sentiment_prediction_id") REFERENCES "sentiment_predictions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shap_explanations" ADD CONSTRAINT "shap_explanations_churn_prediction_id_fkey" FOREIGN KEY ("churn_prediction_id") REFERENCES "churn_predictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_explanations" ADD CONSTRAINT "ai_explanations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_explanations" ADD CONSTRAINT "ai_explanations_fusion_score_id_fkey" FOREIGN KEY ("fusion_score_id") REFERENCES "fusion_scores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_interventions" ADD CONSTRAINT "retention_interventions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_interventions" ADD CONSTRAINT "retention_interventions_discount_request_id_fkey" FOREIGN KEY ("discount_request_id") REFERENCES "discount_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
