-- includes_walkthrough was accepted by POST /api/discount-requests, used to
-- build that submission's audit label, and then thrown away — there was no
-- column for it. The Director reviewing the request therefore never saw that
-- a product walkthrough was part of it, and the approve/reject audit rows
-- couldn't mention it either.
--
-- Defaults to false: every existing request was raised through a UI that
-- offered the option, so an unset value genuinely means "no walkthrough"
-- rather than "unknown".

ALTER TABLE "discount_requests" ADD COLUMN "includes_walkthrough" BOOLEAN NOT NULL DEFAULT false;
