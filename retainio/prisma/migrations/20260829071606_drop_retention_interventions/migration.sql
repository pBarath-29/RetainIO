-- retention_interventions was designed to close the feedback loop: record
-- which retention action was applied to an account (interventionType,
-- discountPct) and whether it worked (renewed, outcomeObservedAt), so the
-- uplift model could eventually be retrained on real outcomes rather than
-- Datasets/uplift_observational.csv. That outcome-tracking flow was never
-- built — nothing in the app ever wrote or read this table, and it held 0
-- rows. Removed rather than kept unused, same reasoning as dropping
-- dominant_driver, model_versions, sentiment_predictions.score, and
-- churn_predictions.predicted_default/predicted_tuned.

ALTER TABLE "retention_interventions" DROP CONSTRAINT "retention_interventions_account_id_fkey";
ALTER TABLE "retention_interventions" DROP CONSTRAINT "retention_interventions_discount_request_id_fkey";

DROP TABLE "retention_interventions";
