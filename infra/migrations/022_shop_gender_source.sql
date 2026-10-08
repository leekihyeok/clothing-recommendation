-- shops.gender를 어디서 정했나: rule(카카오·공공 분류, 이름·소개 말) | brand(같은 브랜드 다른 지점) | ai(채점 때 글을 읽고).
-- pipeline.gender는 rule·brand만 다시 쓰고, 근거가 사라지면 지운다. ai는 근거 규칙이 말할 게 없을 때 남겨 둔다.
ALTER TABLE shops ADD COLUMN gender_source text CHECK (gender_source IN ('rule', 'brand', 'ai'));
UPDATE shops SET gender_source = 'rule' WHERE gender IS NOT NULL;
