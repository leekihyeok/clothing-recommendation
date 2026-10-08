-- The model name a call asked for (an alias like gemini-flash-lite-latest); `model` keeps the version that answered.
-- Free-tier quotas are per requested model per day, so the batch budget (ai/client.py) counts by this column.
ALTER TABLE llm_calls ADD COLUMN requested_model text;
CREATE INDEX llm_calls_day_idx ON llm_calls (created_at) WHERE ok AND run_id IS NOT NULL;
