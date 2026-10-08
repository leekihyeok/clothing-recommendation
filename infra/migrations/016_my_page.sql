-- My page: courses a person kept on purpose ("저장한 코스", unlike the automatic recent list), and a nickname they
-- chose themselves, which a later Kakao login must not overwrite.
CREATE TABLE saved_courses (
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    course_id  uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, course_id)
);
CREATE INDEX saved_courses_user_idx ON saved_courses (user_id, created_at DESC);

ALTER TABLE users ADD COLUMN nickname_custom boolean NOT NULL DEFAULT false;
