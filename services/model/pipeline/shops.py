"""Pipeline step ②-b: build shops from public-data rows, using the building types.

- department_store / outlet / mall: one 'complex' shop per building; its tenants link to it and are not listed alone.
- wholesale_mall: tenants are left unlinked (excluded).
- market / other / small buildings: one shop per row; market tenants get in_market = true.

Kakao places are merged in later by the dedupe step. Re-running rebuilds the sbiz-derived shops from scratch.

Usage: python -m pipeline.shops
"""

import json

from pipeline.buildings import COMPLEX_KINDS
from pipeline.db import connect, pipeline_run, refuse_if_user_data

def apply_manual_kinds(conn) -> None:
    """Fixes for buildings AI left untyped (2026-06 data: 남대문 도깨비수입상가)."""
    conn.execute(
        """UPDATE buildings SET kind = 'market', kind_reason = '남대문시장 내 수입상가', kind_source = 'manual', updated_at = now()
           WHERE kind IS NULL AND name LIKE '%%수입상가%%' AND road_address LIKE '%%남대문시장%%'"""
    )


def build() -> dict:
    with connect() as conn, pipeline_run(conn, "build_shops") as stats:
        refuse_if_user_data(conn)
        apply_manual_kinds(conn)
        complex_kinds = list(COMPLEX_KINDS)

        conn.execute("UPDATE raw_sources SET shop_id = NULL WHERE source = 'sbiz'")
        conn.execute("DELETE FROM shops WHERE id NOT IN (SELECT shop_id FROM raw_sources WHERE shop_id IS NOT NULL)")

        # One complex shop per department store / outlet / mall building.
        conn.execute(
            """INSERT INTO shops (kind, name, road_address, building_id, geom, category, category_source, category_reason)
               SELECT 'complex', coalesce(b.name, b.road_address), b.road_address, b.building_id, b.geom,
                      'complex', 'rule', 'building kind: ' || b.kind
               FROM buildings b WHERE b.kind = ANY(%s)""",
            (complex_kinds,),
        )
        stats["complex_shops"] = conn.execute(
            """UPDATE raw_sources r SET shop_id = s.id FROM shops s
               WHERE r.source = 'sbiz' AND s.kind = 'complex' AND s.building_id = r.building_id"""
        ).rowcount

        # Everything else that is not in a wholesale building becomes its own shop.
        rows = conn.execute(
            """SELECT r.id, r.name, r.branch, r.address, r.road_address, r.building_id, b.kind
               FROM raw_sources r LEFT JOIN buildings b ON b.building_id = r.building_id
               WHERE r.source = 'sbiz' AND r.shop_id IS NULL AND (b.kind IS NULL OR b.kind NOT IN ('wholesale_mall'))"""
        ).fetchall()
        with conn.cursor() as cur:
            for raw_id, name, branch, address, road, building_id, kind in rows:
                display = f"{name} {branch}" if branch and branch not in name else name
                cur.execute(
                    """INSERT INTO shops (name, address, road_address, building_id, geom, in_market)
                       SELECT %s, %s, %s, b.building_id, r.geom, %s
                       FROM raw_sources r LEFT JOIN buildings b ON b.building_id = %s
                       WHERE r.id = %s RETURNING id""",
                    (display, address, road, kind == "market", building_id, raw_id),
                )
                cur.execute("UPDATE raw_sources SET shop_id = %s WHERE id = %s", (cur.fetchone()[0], raw_id))
        stats["single_shops"] = len(rows)
        stats["wholesale_excluded"] = conn.execute(
            """SELECT count(*) FROM raw_sources r JOIN buildings b ON b.building_id = r.building_id
               WHERE r.source = 'sbiz' AND b.kind = 'wholesale_mall'"""
        ).fetchone()[0]
        stats["shops"] = dict(conn.execute("SELECT kind, count(*) FROM shops GROUP BY kind").fetchall())
        stats["in_market"] = conn.execute("SELECT count(*) FROM shops WHERE in_market").fetchone()[0]
    return stats


if __name__ == "__main__":
    print(json.dumps(build(), ensure_ascii=False, indent=2))
