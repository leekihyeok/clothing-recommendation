-- A shop someone saved or visited must not vanish when the pipeline rebuilds shops (shops.py / dedupe.py delete and
-- recreate rows). Block the delete instead of cascading it away; the pipeline also refuses full rebuilds then.
ALTER TABLE user_shop_events DROP CONSTRAINT user_shop_events_shop_id_fkey;
ALTER TABLE user_shop_events ADD CONSTRAINT user_shop_events_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE RESTRICT;
