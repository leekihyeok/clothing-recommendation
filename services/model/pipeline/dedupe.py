"""Pipeline step ②-c: merge Kakao places into shops.

For each Kakao place, in order:
1. its road address is a department store / outlet / mall building, or its name says so and it is within 150 m of
   one → link to that complex shop
2. its road address is a wholesale building → skip (excluded)
3. a shop within 30 m has a similar name (pg_trgm) or one name contains the other, or a shop within 150 m has the
   same normalized name → link
4. otherwise → new shop

--incremental (monthly refresh): only Kakao places not linked to a shop yet; existing shops, their ids and the user
records on them stay as they are. Without it every Kakao link is rebuilt, which is refused once users have records.

Usage: python -m pipeline.dedupe [--similarity 0.3] [--incremental]
"""

import argparse
import json

from pipeline.db import connect, pipeline_run, refuse_if_user_data

# Names compared without a trailing " …점" branch word, brackets, spaces and case.
NORM = r"""lower(regexp_replace(regexp_replace(regexp_replace({col}, '\s+\S+점$', ''), '\(.*?\)|\[.*?\]', '', 'g'), '\s', '', 'g'))"""
COMPLEX_NAME_HINT = "백화점|아울렛|몰|에비뉴엘|타임스퀘어|스타필드|코엑스|하이페리온|엔터식스|뉴코아|NC|IFC|아이파크|디큐브|가든파이브|지하상가|지하쇼핑"
# Kakao writes "서울 중구 …", the public data "서울특별시 중구 …".
ROAD = "replace({col}, '서울특별시', '서울')"


def run(similarity: float, incremental: bool = False) -> dict:
    with connect() as conn, pipeline_run(conn, "dedupe_incremental" if incremental else "dedupe") as stats:
        conn.execute("SELECT set_config('pg_trgm.similarity_threshold', %s, false)", (str(similarity),))
        if not incremental:
            refuse_if_user_data(conn)
            # Kakao-only shops are rebuilt each run so thresholds can be tuned.
            conn.execute("UPDATE raw_sources SET shop_id = NULL WHERE source = 'kakao'")
            conn.execute("DELETE FROM shops s WHERE NOT EXISTS (SELECT 1 FROM raw_sources r WHERE r.shop_id = s.id)")

        stats["to_complex"] = conn.execute(
            f"""UPDATE raw_sources r SET shop_id = s.id
                FROM shops s JOIN buildings b ON b.building_id = s.building_id
                WHERE r.source = 'kakao' AND r.shop_id IS NULL AND s.kind = 'complex'
                  AND {ROAD.format(col='r.road_address')} = {ROAD.format(col='b.road_address')}"""
        ).rowcount

        # Tenants whose Kakao address differs from the building's ("르베이지 현대백화점무역센터점"): name says
        # department store / outlet / mall and the place is next to a complex building.
        stats["to_complex_by_name"] = conn.execute(
            """UPDATE raw_sources r SET shop_id = m.shop_id
               FROM (
                   SELECT DISTINCT ON (k.id) k.id AS raw_id, s.id AS shop_id
                   FROM raw_sources k JOIN shops s ON s.kind = 'complex' AND ST_DWithin(s.geom, k.geom, 150)
                   WHERE k.source = 'kakao' AND k.shop_id IS NULL AND k.name ~ %s
                   ORDER BY k.id, ST_Distance(s.geom, k.geom)
               ) m
               WHERE r.id = m.raw_id""",
            (COMPLEX_NAME_HINT,),
        ).rowcount

        wholesale = conn.execute(
            f"""SELECT r.id FROM raw_sources r JOIN buildings b
                  ON {ROAD.format(col='r.road_address')} = {ROAD.format(col='b.road_address')}
                WHERE r.source = 'kakao' AND r.shop_id IS NULL AND b.kind = 'wholesale_mall'"""
        ).fetchall()
        wholesale_ids = [w[0] for w in wholesale]
        stats["wholesale_skipped"] = len(wholesale_ids)

        stats["matched_near"] = conn.execute(
            f"""UPDATE raw_sources r SET shop_id = m.shop_id
                FROM (
                    SELECT DISTINCT ON (k.id) k.id AS raw_id, s.id AS shop_id
                    FROM raw_sources k
                    JOIN shops s ON s.kind = 'store' AND ST_DWithin(s.geom, k.geom, 150)
                    WHERE k.source = 'kakao' AND k.shop_id IS NULL AND NOT (k.id = ANY(%s))
                      AND (
                        ({NORM.format(col='s.name')} = {NORM.format(col='k.name')} AND {NORM.format(col='k.name')} <> '')
                        OR (ST_DWithin(s.geom, k.geom, 30) AND {NORM.format(col='s.name')} %% {NORM.format(col='k.name')})
                        OR (ST_DWithin(s.geom, k.geom, 30) AND least(length({NORM.format(col='s.name')}), length({NORM.format(col='k.name')})) >= 2
                            AND (strpos({NORM.format(col='s.name')}, {NORM.format(col='k.name')}) > 0
                                 OR strpos({NORM.format(col='k.name')}, {NORM.format(col='s.name')}) > 0))
                      )
                    ORDER BY k.id, ST_Distance(s.geom, k.geom)
                ) m
                WHERE r.id = m.raw_id""",
            (wholesale_ids,),
        ).rowcount

        new = conn.execute(
            """SELECT id FROM raw_sources WHERE source = 'kakao' AND shop_id IS NULL AND NOT (id = ANY(%s))""",
            (wholesale_ids,),
        ).fetchall()
        with conn.cursor() as cur:
            for (raw_id,) in new:
                cur.execute(
                    """INSERT INTO shops (name, address, road_address, geom)
                       SELECT name, address, road_address, geom FROM raw_sources WHERE id = %s RETURNING id""",
                    (raw_id,),
                )
                cur.execute("UPDATE raw_sources SET shop_id = %s WHERE id = %s", (cur.fetchone()[0], raw_id))
        stats["new_shops"] = len(new)

        stats["shops"] = dict(conn.execute("SELECT kind, count(*) FROM shops GROUP BY kind").fetchall())
        stats["shops_by_sources"] = dict(
            conn.execute(
                """SELECT srcs, count(*) FROM (
                       SELECT s.id, string_agg(DISTINCT r.source, '+' ORDER BY r.source) AS srcs
                       FROM shops s JOIN raw_sources r ON r.shop_id = s.id WHERE s.kind = 'store' GROUP BY s.id
                   ) t GROUP BY srcs"""
            ).fetchall()
        )
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--similarity", type=float, default=0.3)
    p.add_argument("--incremental", action="store_true", help="only places not linked yet; keep existing shops")
    a = p.parse_args()
    print(json.dumps(run(a.similarity, a.incremental), ensure_ascii=False, indent=2))
