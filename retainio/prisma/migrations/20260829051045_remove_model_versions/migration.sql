-- model_versions was write-only: every daily snapshot looked one up and
-- attached it, but nothing ever read a model_versions row anywhere in the
-- app (there's only ever one active model per family right now). Removed
-- rather than kept unused, same reasoning as dropping dominant_driver.

ALTER TABLE "churn_predictions" DROP CONSTRAINT "churn_predictions_model_version_id_fkey";
ALTER TABLE "sentiment_predictions" DROP CONSTRAINT "sentiment_predictions_model_version_id_fkey";

ALTER TABLE "churn_predictions" DROP COLUMN "model_version_id";
ALTER TABLE "sentiment_predictions" DROP COLUMN "model_version_id";

DROP TABLE "model_versions";

DROP TYPE "ModelFamily";
