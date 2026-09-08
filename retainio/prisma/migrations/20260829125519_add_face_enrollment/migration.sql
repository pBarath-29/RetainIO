-- Records that a user has enrolled their face at signup. The samples live in
-- model_service/face_data/<user id>/, so a scan resolves to a users.id and
-- /api/face-verify can require that it matches the logged-in approver.
-- Nullable: existing seeded users have not enrolled, and managers never need to.

ALTER TABLE "users" ADD COLUMN "face_enrolled_at" TIMESTAMP(3);
