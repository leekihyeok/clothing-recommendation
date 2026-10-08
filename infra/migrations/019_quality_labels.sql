-- Admin spot checks ("표본 확인", /admin): a person looks at a random sample of scored shops and says whether the
-- summary and style scores are right. Gives an accuracy per region and fixes what was found:
-- wrong → confidence capped (recommended less), closed → status 'suspended' for the closure re-check.
CREATE TABLE quality_labels (
    id         bigserial PRIMARY KEY,
    shop_id    bigint      NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    verdict    text        NOT NULL CHECK (verdict IN ('good', 'wrong_style', 'wrong_info', 'closed')),
    note       text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quality_labels_shop_idx ON quality_labels (shop_id, created_at DESC);
