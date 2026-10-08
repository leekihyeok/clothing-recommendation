-- Stage 7: "문 닫혀 있었어요" reports act on their own.
-- Enough reports put a shop on status 'suspended' (out of courses and the map, like any non-candidate) right away;
-- pipeline.closures re-checks it and either brings it back ('candidate') or confirms it ('closed').
-- Every check is kept here. Reports made before an 'open' check no longer count, so one wave of wrong reports
-- doesn't hide a shop again.
CREATE TABLE shop_checks (
    id          bigserial PRIMARY KEY,
    shop_id     bigint      NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    kind        text        NOT NULL DEFAULT 'closure',
    trigger     text        NOT NULL,              -- reports | pipeline
    result      text        NOT NULL CHECK (result IN ('suspended', 'open', 'closed', 'unsure')),
    detail      jsonb       NOT NULL DEFAULT '{}',
    checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shop_checks_shop_idx ON shop_checks (shop_id, checked_at DESC);
