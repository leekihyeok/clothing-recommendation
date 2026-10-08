-- 가게 웹사이트 (사장님이 적는 칸). 카카오 로컬 API에는 홈페이지 정보가 없어 사장님 정보로만 받는다.
ALTER TABLE shop_owner_info ADD COLUMN website text;
