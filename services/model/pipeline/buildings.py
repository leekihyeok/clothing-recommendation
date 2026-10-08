"""Pipeline step ②-a: find buildings packed with clothing tenants and let AI say what kind of place each one is.

Department stores, outlets and malls become one course stop (their tenants are not listed separately).
Wholesale malls are excluded. Traditional markets keep their shops but flag them.

Usage: python -m pipeline.buildings [--min-tenants 10] [--retype]
"""

import argparse
import json
from collections import Counter
from typing import Literal

from pydantic import BaseModel, Field

from ai import generate
from pipeline.db import connect, pipeline_run

Kind = Literal["department_store", "outlet", "mall", "wholesale_mall", "market", "other"]
COMPLEX_KINDS = {"department_store", "outlet", "mall"}

SYSTEM = """너는 서울 상권 데이터를 정리하는 도우미다.
건물 하나에 의류 매장이 여러 개 등록되어 있다. 건물 이름, 주소, 층 분포, 매장 이름 표본을 보고 그 건물이 어떤 곳인지 하나로 고른다.

- department_store: 백화점 (롯데·현대·신세계·갤러리아·AK·NC백화점·뉴코아 등). 백화점과 붙은 역사·쇼핑몰도 포함
- outlet: 아울렛 (현대시티아울렛, 마리오아울렛, 패션타워 등 가산 아울렛 단지 포함)
- mall: 소매 쇼핑몰, 지하상가, 역사 쇼핑센터, 복합몰 (밀리오레, 두타, 굿모닝시티, 고속터미널 지하상가, 스타필드, 타임스퀘어, 디큐브시티 등)
- wholesale_mall: 도매 위주 상가 (동대문 apM·청평화·디자이너클럽, 남대문 아동복 도매상가 등). 일반 손님이 걸어 들어가 사는 곳이 아니다
- market: 전통시장·재래시장 (남대문시장 거리 상가, 이태원시장, 풍물시장 등). 소매 점포가 섞여 있다
- other: 위에 해당하지 않음 (아파트 단지 상가, 오피스 빌딩, 일반 상가 건물, 주소가 같은 거리 매장 묶음 등)

모르면 other를 고른다. reason은 한국어 한 문장으로 짧게."""


class BuildingKind(BaseModel):
    building_id: str
    kind: Kind
    reason: str = Field(description="판단 근거 한 문장")


class BuildingKinds(BaseModel):
    buildings: list[BuildingKind]


def refresh_buildings(conn, min_tenants: int) -> int:
    rows = conn.execute(
        """SELECT building_id, count(*), ST_X(ST_Centroid(ST_Collect(geom::geometry))), ST_Y(ST_Centroid(ST_Collect(geom::geometry))),
                  mode() WITHIN GROUP (ORDER BY building_name), mode() WITHIN GROUP (ORDER BY road_address)
           FROM raw_sources WHERE source = 'sbiz' AND building_id IS NOT NULL
           GROUP BY building_id HAVING count(*) >= %s""",
        (min_tenants,),
    ).fetchall()
    for building_id, n, lon, lat, name, road in rows:
        conn.execute(
            """INSERT INTO buildings (building_id, name, road_address, geom, tenant_count)
               VALUES (%s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
               ON CONFLICT (building_id) DO UPDATE SET name = EXCLUDED.name, road_address = EXCLUDED.road_address,
                   geom = EXCLUDED.geom, tenant_count = EXCLUDED.tenant_count, updated_at = now()""",
            (building_id, name, road, lon, lat, n),
        )
    conn.commit()
    return len(rows)


def describe(conn, building_id: str) -> dict:
    tenants = conn.execute(
        "SELECT name, floor, payload->>'행정동명' FROM raw_sources WHERE source = 'sbiz' AND building_id = %s ORDER BY random()",
        (building_id,),
    ).fetchall()
    b = conn.execute("SELECT name, road_address, tenant_count FROM buildings WHERE building_id = %s", (building_id,)).fetchone()
    floors = Counter((f or "?") for _, f, _ in tenants)
    names = Counter(n for n, _, _ in tenants)
    return {
        "building_id": building_id,
        "building_name": b[0] or "(없음)",
        "road_address": b[1],
        "dong": tenants[0][2] if tenants else None,
        "clothing_tenants": b[2],
        "floors": dict(floors.most_common(8)),
        "tenant_samples": [n for n, _ in names.most_common(20)],
    }


def classify(retype: bool, min_tenants: int, batch_size: int = 15) -> dict:
    with connect() as conn, pipeline_run(conn, "classify_buildings") as stats:
        stats["buildings"] = refresh_buildings(conn, min_tenants)
        where = "" if retype else "WHERE kind IS NULL"
        todo = [r[0] for r in conn.execute(f"SELECT building_id FROM buildings {where} ORDER BY tenant_count DESC")]
        stats["typed"] = 0
        for i in range(0, len(todo), batch_size):
            chunk = [describe(conn, b) for b in todo[i : i + batch_size]]
            result = generate(
                purpose="classify_buildings",
                system=SYSTEM,
                prompt="각 건물의 종류를 골라라.\n\n" + json.dumps(chunk, ensure_ascii=False, indent=1),
                schema=BuildingKinds,
                tier="smart",
                conn=conn,
                run_id=stats["run_id"],
            )
            asked = {c["building_id"] for c in chunk}
            for b in result.buildings:
                if b.building_id not in asked:
                    continue
                conn.execute(
                    "UPDATE buildings SET kind = %s, kind_reason = %s, kind_source = 'ai', updated_at = now() WHERE building_id = %s",
                    (b.kind, b.reason, b.building_id),
                )
                stats["typed"] += 1
            conn.commit()
            print(f"  {min(i + batch_size, len(todo))}/{len(todo)} buildings")
        stats["kinds"] = dict(conn.execute("SELECT coalesce(kind, 'untyped'), count(*) FROM buildings GROUP BY 1").fetchall())
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--min-tenants", type=int, default=10)
    p.add_argument("--retype", action="store_true", help="re-ask AI for buildings already typed")
    a = p.parse_args()
    print(json.dumps(classify(a.retype, a.min_tenants), ensure_ascii=False, indent=2))
