-- Stage 7: share links and "지난번처럼".
-- Sharing stores a frozen copy of the course as it was on screen; the link points at that copy, so later edits by the
-- sender don't change what was sent. Editing a frozen copy forks it into a new course owned by whoever edits.
ALTER TABLE courses
    ADD COLUMN frozen      boolean NOT NULL DEFAULT false,
    ADD COLUMN shared_from uuid REFERENCES courses (id) ON DELETE SET NULL,
    ADD COLUMN opened      integer NOT NULL DEFAULT 0;   -- times a share link was opened

CREATE INDEX courses_user_idx ON courses (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX courses_shared_from_idx ON courses (shared_from) WHERE shared_from IS NOT NULL;
