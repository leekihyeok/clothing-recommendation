-- "비슷한 가게": 가게 소개·들를 이유·스타일·품목을 묶은 글의 임베딩 (pipeline.embed, Gemini gemini-embedding-001, 768차원).
-- 가게 화면이 이걸로 비슷한 가게를 찾는다 (코사인 거리, 가까운 곳 조금 앞으로). 채점된 가게만 있다.
ALTER TABLE shops
    ADD COLUMN embedding   vector(768),
    ADD COLUMN embedded_at timestamptz;   -- 임베딩한 때. scored_at보다 오래되면 다시 만든다

CREATE INDEX shops_embedding_idx ON shops USING hnsw (embedding vector_cosine_ops);
