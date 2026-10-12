-- 검증(⑥)이 신뢰도 0을 준 가게: 모은 글이 다른 가게·다른 대상 이야기다 ("초이스" → 통신사 요금제 글).
-- 그 글에서 나온 소개·스타일 점수·평판·영업시간·브랜드를 지우고 "정보가 적은 가게"로 둔다(pipeline.wrong_evidence).
-- 언제 지웠는지 남겨 둔다. 반년 뒤 근거를 다시 모으면(blogs) 다시 채점·검증된다.
ALTER TABLE shops ADD COLUMN evidence_rejected_at timestamptz;
