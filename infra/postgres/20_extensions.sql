-- Runs once, when the data volume is first created.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- shop name similarity for dedupe (pipeline step 2)
