-- Stage 7: ready-made course ideas on the first screen ("성수 미니멀 산책" …). Picked from region × style supply by
-- pipeline.presets, named by AI. Re-running replaces them all; courses don't reference presets.
CREATE TABLE presets (
    id           bigserial PRIMARY KEY,
    region_id    bigint      NOT NULL REFERENCES regions (id) ON DELETE CASCADE,
    styles       text[]      NOT NULL,            -- catalog style ids
    stop_count   int         NOT NULL,
    title        text        NOT NULL,            -- short name, e.g. "성수 미니멀 산책"
    intro        text,                            -- one line, from the shops that fit
    fit_count    int         NOT NULL,            -- shops in the region that fit the styles
    scored_share real        NOT NULL,            -- how much of that rests on real style scores (vs. category guesses)
    rank         real        NOT NULL,            -- higher first
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX presets_rank_idx ON presets (rank DESC);
