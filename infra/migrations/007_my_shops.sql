-- "내 가게": who (anonymous browser for now; Kakao login later merges into the same row) did what with which shop.
CREATE TABLE users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anon_key     text UNIQUE,                       -- random UUID the browser keeps in localStorage
    kind         text        NOT NULL DEFAULT 'anon', -- anon | kakao (stage 7)
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- One row per action. "Saved" / rating are the latest save/unsave and like/dislike/unrate rows.
CREATE TABLE user_shop_events (
    id         bigserial PRIMARY KEY,
    user_id    uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    shop_id    bigint NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    kind       text   NOT NULL CHECK (kind IN ('view', 'save', 'unsave', 'visit', 'unvisit', 'like', 'dislike', 'unrate', 'purchase', 'closed')),
    course_id  uuid REFERENCES courses (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_shop_events_user_shop_idx ON user_shop_events (user_id, shop_id, created_at);
-- "문 닫혀 있었어요" reports feed the data-quality checks (PLAN.md 5.3).
CREATE INDEX user_shop_events_closed_idx ON user_shop_events (shop_id) WHERE kind = 'closed';

ALTER TABLE courses ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE SET NULL;
