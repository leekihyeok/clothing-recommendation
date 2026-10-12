-- 걷기를 마친 뒤 "이 코스 어땠어요?": 코스 전체에 대한 한 번의 평가 (좋았어요 1 / 그저 그랬어요 0 / 별로였어요 -1)와 한 줄.
-- 추천을 고칠 근거로 모은다 (관리자 화면 "데이터 건강"에서 본다). 사람마다 코스 하나에 하나, 다시 고르면 바뀐다.
CREATE TABLE course_ratings (
    course_id  uuid        NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating     smallint    NOT NULL CHECK (rating BETWEEN -1 AND 1),
    note       text        CHECK (char_length(note) <= 300),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (course_id, user_id)
);
CREATE INDEX course_ratings_created_idx ON course_ratings (created_at);
