-- Four columns written but never read anywhere in the app.
--
--  * sentiment_predictions.text_length — the ticket's character count, stored
--    on every prediction and displayed nowhere. The text itself lives on
--    support_tickets, so the length is recoverable if ever wanted.
--
--  * ai_explanations.model — always the literal 'gemini-3.6-flash'; nothing
--    read it, and the generating model is a code-level fact, not a per-row one.
--
--  * ai_explanations.fusion_score_id — meant to tie an explanation to the exact
--    fusion score it explained, but mapAccount only ever takes the newest
--    explanation by date, so the link was never followed.
--
--  * users.requires_facial_verification — the pre-enrolment way of marking who
--    needed a face check. That question is now answered by whether the user
--    actually has rows in face_samples, which /api/face-verify checks directly,
--    so this flag could only ever disagree with reality.

ALTER TABLE "sentiment_predictions" DROP COLUMN "text_length";

ALTER TABLE "ai_explanations" DROP CONSTRAINT IF EXISTS "ai_explanations_fusion_score_id_fkey";
ALTER TABLE "ai_explanations" DROP COLUMN "fusion_score_id";
ALTER TABLE "ai_explanations" DROP COLUMN "model";

ALTER TABLE "users" DROP COLUMN "requires_facial_verification";
