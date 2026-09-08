-- predicted_default/predicted_tuned were meant to hold churn_model.ipynb's
-- binary predictions at the 0.5 and 0.56 thresholds, but no write path in the
-- real app (fusionSnapshot.ts, seed-phase2.ts, backfill-real-fusion.ts) ever
-- set them — confirmed all 72 existing churn_predictions rows have both
-- columns NULL. Removed rather than kept unused, same reasoning as dropping
-- dominant_driver, model_versions, and sentiment_predictions.score.

ALTER TABLE "churn_predictions" DROP COLUMN "predicted_default";
ALTER TABLE "churn_predictions" DROP COLUMN "predicted_tuned";
