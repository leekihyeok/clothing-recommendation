-- 되돌리기를 서버에서: 고치기마다 바뀌기 전 버전을 쌓아 두고(최근 30개), 되돌리면 꺼내서 결과에 다시 쓴다.
-- 전에는 되돌리기가 화면에서만 돼서 새로고침하면 되돌린 수정이 다시 살아났다.
ALTER TABLE courses ADD COLUMN undo jsonb NOT NULL DEFAULT '[]';
