-- 누구 옷을 파는 가게인지: men | women | unisex | kids, 모르면 NULL. pipeline.gender가 카카오 분류(여성의류 · 남성의류,양복 ·
-- 아동복,유아복), 공공데이터 업종(여성/남성 의류 소매업), 이름·소개글의 말(맨즈·옴므·우먼·남녀공용 …)로 채운다.
-- 코스 요청의 "남성복 / 여성복"이 이걸로 거른다 (모르는 가게는 빼지 않고 조금 뒤로).
ALTER TABLE shops ADD COLUMN gender text CHECK (gender IN ('men', 'women', 'unisex', 'kids'));
