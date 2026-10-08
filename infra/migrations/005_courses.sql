-- Stage 4: planned courses. The request and the full result are stored so a course can be reopened/shared later,
-- and so recommendation outcomes are kept from day one (PLAN.md 2.5).
CREATE TABLE courses (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request     jsonb       NOT NULL,   -- resolved CourseRequest (origin, styles, counts, defaulted fields)
    result      jsonb       NOT NULL,   -- main course + alternatives, as returned to the client
    input_mode  text        NOT NULL DEFAULT 'buttons',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courses_created_idx ON courses (created_at);
