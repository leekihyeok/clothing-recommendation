-- "내 위치"에서 짠 코스는 공유될 수 있어서, 출발 좌표를 약 200m 격자(위도 0.002°, 경도 0.0025°)로 뭉갠다.
-- 새 코스는 API(plan)가 짜기 전에 반올림한다. 여기서는 이미 저장된 코스의 출발 좌표(request.origin)와
-- 그 좌표가 그대로 들어간 결과(경로 첫 점 등)를 같은 값으로 바꾼다.
WITH g AS (
    SELECT id,
           request->'origin'->>'lat' AS lat0,
           request->'origin'->>'lng' AS lng0,
           (round((request->'origin'->>'lat')::numeric / 0.002) * 0.002)::numeric(9, 4)::text  AS lat1,
           (round((request->'origin'->>'lng')::numeric / 0.0025) * 0.0025)::numeric(9, 4)::text AS lng1
      FROM courses
     WHERE request->>'startName' = '내 위치'
)
UPDATE courses c
   SET request = jsonb_set(jsonb_set(c.request, '{origin,lat}', to_jsonb(g.lat1::numeric)), '{origin,lng}', to_jsonb(g.lng1::numeric)),
       result  = replace(replace(c.result::text, g.lat0, g.lat1), g.lng0, g.lng1)::jsonb,
       edits   = replace(replace(c.edits::text, g.lat0, g.lat1), g.lng0, g.lng1)::jsonb
  FROM g
 WHERE c.id = g.id;
