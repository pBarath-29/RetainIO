-- verification_snapshot_url stored the webcam frame captured during a
-- biometric approval, as evidence of who authorised the discount. Removed for
-- three reasons:
--
--   * Despite the name it held no URL — the entire base64 image went inline
--     into the row, ~40-60 KB of text per approval.
--   * Nothing displayed it. DiscountEmailModal declared the prop and never
--     rendered it, so the photo was captured, threaded through four
--     components, persisted, and shown nowhere.
--   * Face enrolment already moved from images to embeddings specifically to
--     stop keeping biometric photographs; this column reintroduced them
--     through a different door.
--
-- What the approval actually needs is still recorded in `details`: who was
-- verified, the cosine distance, and the threshold it was measured against.

ALTER TABLE "audit_logs" DROP COLUMN "verification_snapshot_url";
