-- 영업시간을 블로그 글에서: 사장님이 올린 영업시간(shop_owner_info.hours)은 아직 거의 없어서, pipeline.hours가 근거 글
-- (shop_facts)의 "영업시간 : 매일 11:00 – 21:00 · 월요일 휴무" 같은 줄을 AI로 읽어 채운다. 형식은 사장님 것과 같다
-- (월~일 7개, {"closed": bool, "open": "11:00", "close": "21:00"}). 코스는 사장님 영업시간 > 이것 순으로 쓰고,
-- 카드에는 "블로그 기준"으로 표시한다. 글이 오래되면(API에서 3년) 쓰지 않는다.
ALTER TABLE shops
    ADD COLUMN hours           jsonb,
    ADD COLUMN hours_note      text,          -- "매월 마지막 월요일 휴무", "라스트오더 20:30" …
    ADD COLUMN hours_url       text,          -- 영업시간을 읽은 글
    ADD COLUMN hours_posted_on date,          -- 그 글의 날짜
    ADD COLUMN hours_at        timestamptz;   -- pipeline.hours가 마지막으로 본 때 (못 찾았어도)
