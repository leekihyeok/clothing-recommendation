-- Stage 1: raw source records, merged shops, pipeline run log, AI call log.

-- One row per record per source (public data CSV row, Kakao place, ...). Re-imports upsert on (source, source_id).
CREATE TABLE raw_sources (
    id             bigserial PRIMARY KEY,
    source         text        NOT NULL,              -- 'sbiz' (공공데이터 상가정보), 'kakao'
    source_id      text        NOT NULL,              -- 상가업소번호 / Kakao place id
    source_version text,                              -- e.g. '202606' for the 2026-06-30 sbiz file
    name           text        NOT NULL,
    branch         text,
    category_code  text,
    category_name  text,
    address        text,                              -- 지번 주소
    road_address   text,
    building_id    text,                              -- 건물관리번호 (sbiz only)
    building_name  text,
    floor          text,
    geom           geography(Point, 4326) NOT NULL,
    payload        jsonb       NOT NULL,              -- the full original record
    shop_id        bigint,                            -- set by the dedupe step
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX raw_sources_geom_idx ON raw_sources USING gist (geom);
CREATE INDEX raw_sources_building_idx ON raw_sources (building_id);
CREATE INDEX raw_sources_shop_idx ON raw_sources (shop_id);

-- Buildings with many clothing tenants, typed once by AI: department stores and malls become a single course stop.
CREATE TABLE buildings (
    building_id    text PRIMARY KEY,                  -- 건물관리번호
    name           text,
    road_address   text,
    geom           geography(Point, 4326) NOT NULL,
    tenant_count   int  NOT NULL,
    kind           text,                              -- department_store | outlet | mall | wholesale_mall | market | other
    kind_reason    text,
    kind_source    text,                              -- 'ai' | 'manual'
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Merged shops. kind = 'store' for a single shop, 'complex' for a department store / mall / outlet treated as one stop.
CREATE TABLE shops (
    id              bigserial PRIMARY KEY,
    kind            text NOT NULL DEFAULT 'store',
    name            text NOT NULL,
    address         text,
    road_address    text,
    building_id     text REFERENCES buildings (building_id),
    geom            geography(Point, 4326) NOT NULL,
    category        text,                             -- select_shop | vintage | brand | spa | complex | wholesale | excluded
    category_source text,                             -- 'rule' | 'ai' | 'manual'
    category_reason text,
    in_market       boolean NOT NULL DEFAULT false,   -- inside a traditional market (남대문, 이태원시장 …)
    status          text NOT NULL DEFAULT 'candidate',-- candidate | published | hidden | excluded
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shops_geom_idx ON shops USING gist (geom);
CREATE INDEX shops_name_trgm_idx ON shops USING gin (name gin_trgm_ops);
CREATE INDEX shops_status_idx ON shops (status);

ALTER TABLE raw_sources ADD CONSTRAINT raw_sources_shop_fk FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE SET NULL;

CREATE TABLE pipeline_runs (
    id          bigserial PRIMARY KEY,
    step        text        NOT NULL,                 -- import_sbiz, classify_buildings, kakao_grid, dedupe, classify_shops …
    status      text        NOT NULL DEFAULT 'running', -- running | ok | failed
    stats       jsonb       NOT NULL DEFAULT '{}',
    error       text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE TABLE llm_calls (
    id            bigserial PRIMARY KEY,
    run_id        bigint REFERENCES pipeline_runs (id),
    purpose       text        NOT NULL,
    provider      text        NOT NULL,               -- gemini | anthropic
    model         text        NOT NULL,
    input_tokens  int,
    output_tokens int,
    cached_tokens int,
    cost_usd      numeric(10, 6) NOT NULL DEFAULT 0,  -- 0 on the Gemini free tier
    latency_ms    int,
    ok            boolean     NOT NULL,
    error         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_created_idx ON llm_calls (created_at);
