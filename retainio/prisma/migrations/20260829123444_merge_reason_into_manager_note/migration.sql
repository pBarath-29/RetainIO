-- discount_requests carried two justification columns that meant different
-- things depending on where the row came from:
--   * reason       — a server-generated template ("Account Manager submitted
--                    a N% retention discount request for high-risk account"),
--                    except on seeded rows, where it held the REAL text.
--   * manager_note — what the Account Manager actually typed, except on
--                    seeded rows, where it was NULL.
-- The Director's dashboard read `managerNote || reason` purely to paper over
-- that split. Collapsing to one column: manager_note.

-- 1. Rescue the meaningful text from the seeded rows before dropping reason.
UPDATE "discount_requests"
SET "manager_note" = "reason"
WHERE "manager_note" IS NULL;

-- 2. Belt and braces: a request with no justification at all can't be judged
--    by a Director, and NOT NULL below would fail on it.
UPDATE "discount_requests"
SET "manager_note" = 'Submitted for Account Director approval.'
WHERE "manager_note" IS NULL OR btrim("manager_note") = '';

-- 3. Every row in this table is a >10% escalation by construction (a <=10%
--    discount is self-approved and never creates a request), so a stated
--    reason is always required.
ALTER TABLE "discount_requests" ALTER COLUMN "manager_note" SET NOT NULL;

ALTER TABLE "discount_requests" DROP COLUMN "reason";
