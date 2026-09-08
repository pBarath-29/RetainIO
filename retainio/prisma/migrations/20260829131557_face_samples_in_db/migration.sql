-- Face enrolment moves off the filesystem and into Postgres.
--
-- model_service/face_data/<user id>/*.png was written next to the code, which
-- breaks on any host with an ephemeral filesystem (a redeploy wipes it and
-- every Director silently loses the ability to approve). It also made
-- model_service stateful, unlike all of its other pure-compute endpoints.
--
-- Stored as the 512-d FaceNet embedding rather than the image: matching only
-- ever needs the vector, it's ~20x smaller, and it avoids retaining
-- biometric photographs the app has no further use for.

CREATE TABLE "face_samples" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "face_samples_user_id_idx" ON "face_samples"("user_id");

-- Cascade: removing a user removes their biometric data with them.
ALTER TABLE "face_samples" ADD CONSTRAINT "face_samples_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
