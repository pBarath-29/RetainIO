-- Renewal intents lose their notes, and the `renewing` kind goes.
--
--  * renewal_intents.notes / renewal_records.notes — a free-text box on the intent form,
--    copied onto the renewal record when the intent was applied. Nothing downstream read
--    either column: the training export (prisma/export-renewal-outcomes.ts) carries only the
--    model inputs and the outcome, so the text was stored and displayed and nothing more.
--
--  * IntentKind 'renewing' — contracts auto-renew unless notice is given, so recording
--    "will renew" produced exactly the outcome that recording nothing did. An intent now
--    exists only for a departure from renewing as-is: churning, upgrading or downgrading.
--
-- 'renewing' intents are deleted before the enum is rebuilt, or the cast below would fail
-- on them. The renewal records they produced are kept — they still say who recorded them
-- and that the outcome was confirmed rather than assumed — and only their pointer to the
-- deleted intent is cleared, since intent_id has no foreign key and would dangle silently.
--
-- One transaction throughout, so a failure part-way cannot leave the columns dropped with
-- the enum untouched.

BEGIN;

ALTER TABLE "renewal_intents" DROP COLUMN "notes";
ALTER TABLE "renewal_records" DROP COLUMN "notes";

UPDATE "renewal_records" SET "intent_id" = NULL
  WHERE "intent_id" IN (SELECT "id" FROM "renewal_intents" WHERE "kind" = 'renewing');
DELETE FROM "renewal_intents" WHERE "kind" = 'renewing';

CREATE TYPE "IntentKind_new" AS ENUM ('upgrading', 'downgrading', 'churning');
ALTER TABLE "renewal_intents" ALTER COLUMN "kind" TYPE "IntentKind_new" USING ("kind"::text::"IntentKind_new");
ALTER TYPE "IntentKind" RENAME TO "IntentKind_old";
ALTER TYPE "IntentKind_new" RENAME TO "IntentKind";
DROP TYPE "IntentKind_old";

COMMIT;
