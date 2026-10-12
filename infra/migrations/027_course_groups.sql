-- 같이 가기: 코스를 만든 사람이 링크를 보내면 친구가 자기 취향(스타일·누구 옷·예산)을 넣고, 모두의 취향을 섞어 같은
-- 동네·시간·고정 가게로 다시 짠다. members: [{"name", "styles", "gender", "budget", "joinedAt"}] (첫 번째가 만든 사람).
-- result_course_id: 가장 최근에 같이 짠 코스.
CREATE TABLE course_groups (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    base_course_id   uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
    created_by       uuid        REFERENCES users (id) ON DELETE SET NULL,
    members          jsonb       NOT NULL DEFAULT '[]',
    result_course_id uuid        REFERENCES courses (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
