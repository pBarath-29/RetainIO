-- Adds the admin role and the Manager -> Director reporting line.
--
-- A Director's visibility stops being "everything" and becomes "the accounts
-- owned by the Managers assigned to me", so a Director with nobody assigned
-- sees an empty dashboard, exactly like a Manager with no accounts.
--
-- Note: the admin user itself is created by prisma/seed-admin.ts rather than
-- here. Postgres will not let a newly added enum value be used in the same
-- transaction that adds it, and Prisma runs each migration in one.

ALTER TYPE "UserRole" ADD VALUE 'admin';

ALTER TABLE "users" ADD COLUMN "director_id" TEXT;

CREATE INDEX "users_director_id_idx" ON "users"("director_id");

-- SetNull, not Cascade: deleting a Director must not delete their Managers.
ALTER TABLE "users" ADD CONSTRAINT "users_director_id_fkey"
    FOREIGN KEY ("director_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
