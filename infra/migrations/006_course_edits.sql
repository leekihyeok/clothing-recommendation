-- Stage 6: every edit a user makes to a course (remove, replace, move, add, replan, by buttons or by text).
-- Kept from day one: how often and how courses get changed says how far off the recommendations were.
ALTER TABLE courses ADD COLUMN edits jsonb NOT NULL DEFAULT '[]';
