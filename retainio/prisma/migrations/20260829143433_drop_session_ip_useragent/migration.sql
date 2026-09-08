-- ip_address / user_agent were captured at login and read nowhere: no active
-- sessions UI, no new-device alerting, no anomaly checks. Running entirely on
-- localhost every stored IP was also 127.0.0.1, so the column couldn't even
-- distinguish one client from another. Removed rather than kept unused, same
-- reasoning as dominant_driver, model_versions, sentiment_predictions.score,
-- churn_predictions.predicted_default/predicted_tuned, and
-- retention_interventions.
--
-- If session provenance is wanted later, it should come back together with the
-- feature that reads it (an "active sessions" panel with revoke), not before.

ALTER TABLE "sessions" DROP COLUMN "ip_address";
ALTER TABLE "sessions" DROP COLUMN "user_agent";
