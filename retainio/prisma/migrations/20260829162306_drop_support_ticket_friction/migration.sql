-- support_ticket_friction stored a value derived from two columns in the very
-- same row: support_tickets_90days / (daily_usage_mins + 1). It was written
-- once by the seed and read by nothing, because model_service recomputes the
-- ratio itself on every prediction (see build_row in model_service/app.py).
--
-- Recomputing is the right design — a derived value that is also stored can
-- drift from its inputs, leaving the database asserting one number while the
-- model uses another, with no way to tell which is correct. Keeping only the
-- inputs makes that impossible.

ALTER TABLE "usage_snapshots" DROP COLUMN "support_ticket_friction";
