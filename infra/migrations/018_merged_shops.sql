-- The same shop listed twice under different scripts ("EQL 성수점" from Kakao, "이큐엘 성수점" from the public data)
-- is merged by pipeline.merge_dupes: the duplicate gets status 'merged' and points at the shop that stays. Nothing is
-- deleted, so a wrong merge can be undone by hand.
ALTER TABLE shops ADD COLUMN merged_into bigint REFERENCES shops (id);
CREATE INDEX shops_merged_into_idx ON shops (merged_into) WHERE merged_into IS NOT NULL;
