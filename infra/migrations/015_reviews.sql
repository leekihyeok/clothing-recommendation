-- Shop detail: our own reviews and star ratings, and a reputation read from the blog posts already collected (step ④).
-- Kakao Map / Naver reviews have no public API and copying them breaks their terms, so they are linked, not stored.

-- One review per person per shop; writing again edits it. Needs a Kakao login (no anonymous reviews).
CREATE TABLE shop_reviews (
    id          bigserial PRIMARY KEY,
    shop_id     bigint      NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    rating      smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body        text        CHECK (length(body) <= 1000),
    hidden      boolean     NOT NULL DEFAULT false,   -- taken down by an admin
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shop_id, user_id)
);
CREATE INDEX shop_reviews_shop_idx ON shop_reviews (shop_id, created_at DESC) WHERE NOT hidden;
CREATE INDEX shop_reviews_user_idx ON shop_reviews (user_id, created_at DESC);

-- Blog reputation (pipeline.reputation): AI reads the collected post titles/snippets.
ALTER TABLE shops
    ADD COLUMN blog_score     real,     -- 1-5, how positively posts talk about the shop
    ADD COLUMN blog_pros      text[],   -- short phrases, e.g. "가격이 착함"
    ADD COLUMN blog_cons      text[],
    ADD COLUMN reputation_at  timestamptz;

-- Profile photo (my page). A path under the API's upload folder; null = initial of the nickname.
ALTER TABLE users ADD COLUMN avatar_path text;
