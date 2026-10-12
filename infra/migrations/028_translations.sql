-- 영어 지원: AI가 쓴 한국어 문장(가게 소개·들를 이유, 지역 이름·소개, 프리셋 제목·소개)의 영어. pipeline.translate가
-- 채우고, API가 영어로 답할 때 이 사전에서 찾아 바꾼다 (없으면 한국어 그대로). 문장 단위라 프리셋을 다시 만들어도
-- 같은 문장은 다시 번역하지 않는다.
CREATE TABLE translations (
    ko         text PRIMARY KEY,
    en         text NOT NULL,
    kind       text NOT NULL,                 -- shop_summary | shop_reason | region_name | region_intro | preset_title | preset_intro
    created_at timestamptz NOT NULL DEFAULT now()
);
