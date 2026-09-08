-- AlterTable
ALTER TABLE "renewal_records" ADD COLUMN     "churn_proba" DOUBLE PRECISION,
ADD COLUMN     "dominant_shap_driver" TEXT,
ADD COLUMN     "sentiment_score" DOUBLE PRECISION;
