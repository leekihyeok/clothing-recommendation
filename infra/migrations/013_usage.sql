-- Stage 7: usage numbers (PLAN.md 13). Only what the API itself handles is logged: no page views, no client
-- tracking, and no text the user typed (its length at most).
CREATE TABLE app_events (
    id          bigserial PRIMARY KEY,
    kind        text        NOT NULL,   -- plan | parse_text | parse_photo | edit | edit_text | share | reopen | login
    user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    course_id   uuid REFERENCES courses (id) ON DELETE SET NULL,
    ms          int,                    -- how long the API took
    ok          boolean     NOT NULL DEFAULT true,
    data        jsonb       NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_events_kind_time_idx ON app_events (kind, created_at);

-- How a course was asked for (buttons | here | point | text | photo | preset | again) and how long planning took.
ALTER TABLE courses ADD COLUMN plan_ms int;
