-- Deactivation as the revocation mechanism, replacing delete for anyone with
-- history. A user who has approved a discount or appears in an audit log
-- cannot be deleted without either breaking a foreign key or erasing the
-- trail that names them — but their access still needs to be removable.
--
-- is_active = false blocks login, invalidates any live session, and drops the
-- user out of assignment lists, while every historical row keeps pointing at
-- the real person who did the thing.

ALTER TABLE "users" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "deactivated_at" TIMESTAMP(3);
