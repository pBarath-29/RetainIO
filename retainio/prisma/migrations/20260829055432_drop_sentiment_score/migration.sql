-- score (-1..1 display value, P(Satisfied) - P(Frustrated)) was never rendered
-- anywhere in the UI — confirmed via grep across src/. riskWeight (the value
-- the fusion model actually consumes, and what the "Sentiment Risk Weight"
-- card shows) already covers the only real use case. Removed rather than
-- kept unused, same reasoning as dropping dominant_driver and model_versions.

ALTER TABLE "sentiment_predictions" DROP COLUMN "score";
