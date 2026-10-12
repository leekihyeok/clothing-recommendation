-- 브랜드로 찾기: "아더에러 파는 데". 브랜드 사전(brands)과 가게마다 다루는 브랜드(shop_brands).
-- pipeline.brands가 채운다: 브랜드 매장은 이름에서(규칙), 편집숍·빈티지는 근거 글에 "이 가게에서 판다"고 나온 브랜드를 AI로.
-- key는 정규화한 이름(영문 소문자·한글, 기호·띄어쓰기 없음). 한글·영문 표기를 aliases에 같이 둬서 어느 쪽으로 찾아도 된다.
CREATE TABLE brands (
    key        text PRIMARY KEY,
    name       text NOT NULL,                 -- 보여 줄 이름 (예: 아더에러)
    name_en    text,                          -- 영문 표기 (예: ADER ERROR)
    aliases    text[] NOT NULL DEFAULT '{}'   -- 찾을 때 맞춰 볼 정규화한 이름들 (key 포함)
);
CREATE INDEX brands_aliases_idx ON brands USING gin (aliases);
CREATE INDEX brands_name_trgm_idx ON brands USING gin (name gin_trgm_ops);

CREATE TABLE shop_brands (
    shop_id    bigint NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    brand_key  text   NOT NULL REFERENCES brands (key) ON DELETE CASCADE,
    source     text   NOT NULL,               -- name (브랜드 매장 이름) | blog (근거 글)
    PRIMARY KEY (shop_id, brand_key)
);
CREATE INDEX shop_brands_brand_idx ON shop_brands (brand_key);

ALTER TABLE shops ADD COLUMN brands_at timestamptz;  -- pipeline.brands가 마지막으로 본 때
