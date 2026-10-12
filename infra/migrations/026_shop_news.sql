-- 사장님 소식: 승인된 사장님(shop_owners)이 가게 소식을 올린다 (신상 입고, 세일, 이벤트, 공지).
-- 가게 화면 "사장님 소식", 마이페이지 "찜한 가게 소식", 코스 카드 태그("세일 중")에 나온다. 지우면 deleted_at.
CREATE TABLE shop_news (
    id          bigserial PRIMARY KEY,
    shop_id     bigint      NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    author_id   uuid        REFERENCES users (id) ON DELETE SET NULL,
    kind        text        NOT NULL CHECK (kind IN ('new', 'sale', 'event', 'notice')),
    title       text        NOT NULL,
    body        text,
    ends_on     date,                         -- 세일·이벤트 끝나는 날 (없으면 올린 뒤 30일 동안 보임)
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE INDEX shop_news_shop_idx ON shop_news (shop_id, created_at DESC) WHERE deleted_at IS NULL;
