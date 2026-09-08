-- dominant_driver was write-only (set on every insert, never read anywhere
-- in the app) and its comparison logic didn't match the real trained fusion
-- model's actual learned weights (churn coef 4.17 vs sentiment coef 1.67) —
-- removed rather than fixed, since nothing actually needed it.
ALTER TABLE "fusion_scores" DROP COLUMN "dominant_driver";
