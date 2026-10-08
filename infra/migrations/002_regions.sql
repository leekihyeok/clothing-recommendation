-- Stage 2: shopping areas found by clustering shops (pipeline ⑨), named by AI.
CREATE TABLE regions (
    id           bigserial PRIMARY KEY,
    name         text        NOT NULL,                -- 성수, 홍대·연남 …
    intro        text,                                -- one-line description
    name_reason  text,
    polygon      geography(Polygon, 4326) NOT NULL,
    center       geography(Point, 4326)   NOT NULL,
    shop_count   int         NOT NULL,
    category_counts jsonb    NOT NULL,                -- {"select_shop": 12, "vintage": 30, …}
    stations     text[]      NOT NULL DEFAULT '{}',   -- nearby subway stations (Kakao)
    dongs        text[]      NOT NULL DEFAULT '{}',   -- most common 행정동 names
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX regions_polygon_idx ON regions USING gist (polygon);
