-- Stage 7: Kakao login. A Kakao account is a users row (kind = 'kakao'); logging in moves the browser's anonymous
-- records (shop events, courses) onto it, so "내 가게" follows the account to other devices.
ALTER TABLE users
    ADD COLUMN kakao_id bigint UNIQUE,
    ADD COLUMN nickname text;

-- Login sessions. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
    token_hash   text PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
