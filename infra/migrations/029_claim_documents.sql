-- 사장님 신청에 사업자등록증 사진 (국세청 상태조회 API를 쓸 수 없어서, 관리자가 상호·대표자·번호를 눈으로 대조한다).
-- 사진은 공개 폴더(/media)가 아닌 data/private/claims에 두고 관리자만 본다. 승인·거절하면 바로 지우고 doc_path를 비운다.
ALTER TABLE shop_owner_claims
    ADD COLUMN doc_path       text,            -- data/private 아래 상대 경로 (지운 뒤엔 NULL)
    ADD COLUMN doc_removed_at timestamptz;     -- 사진을 지운 때
