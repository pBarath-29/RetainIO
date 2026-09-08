-- support_tickets.source held a free-text provenance label for the feedback
-- ("Escalation Email from VP Infrastructure", "NPS Survey Feedback"). It was
-- mapped through to the client as Account.lastSentimentSource and rendered by
-- no component — the analysis page quotes the ticket body without ever
-- captioning where it came from.
--
-- It also fed nothing: /predict/sentiment reads `body` alone, so the label
-- never influenced a score. Removed rather than kept unused.

ALTER TABLE "support_tickets" DROP COLUMN "source";
