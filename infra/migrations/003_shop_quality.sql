-- Stage 3: evidence about each shop (blog posts …), style scores, and the verified summary used for recommendations.

-- One row per piece of evidence. Blog posts come from the Naver search API (title + snippet only, no page crawling).
CREATE TABLE shop_facts (
    id          bigserial PRIMARY KEY,
    shop_id     bigint      NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    kind        text        NOT NULL,                 -- blog_post
    title       text,
    snippet     text,
    url         text,
    posted_on   date,
    source      text        NOT NULL,                 -- naver_blog
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shop_id, kind, url)
);
CREATE INDEX shop_facts_shop_idx ON shop_facts (shop_id);

-- Style scores 0-10 for the styles in packages/shared/catalog.json.
CREATE TABLE shop_style_scores (
    shop_id   bigint NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    style_id  text   NOT NULL,
    score     smallint NOT NULL CHECK (score BETWEEN 0 AND 10),
    reason    text,
    PRIMARY KEY (shop_id, style_id)
);

ALTER TABLE shops
    ADD COLUMN mention_count    int,           -- blog search total for the shop's query
    ADD COLUMN matched_posts    int,           -- posts that clearly mention this shop
    ADD COLUMN last_mention_on  date,
    ADD COLUMN evidence_at      timestamptz,   -- when evidence was last collected
    ADD COLUMN summary          text,          -- one-line description shown on cards
    ADD COLUMN items            text[],        -- catalog item ids (outer, denim …)
    ADD COLUMN price_range      text,          -- low | mid | high | unknown
    ADD COLUMN reason_material  text,          -- what makes it worth visiting; seeds the "why recommended" line
    ADD COLUMN scored_at        timestamptz,
    ADD COLUMN confidence       real,          -- 0-1, from the verify step
    ADD COLUMN verify_note      text;
