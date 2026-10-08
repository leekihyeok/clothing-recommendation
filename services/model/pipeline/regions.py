"""Pipeline step ⑨: find shopping areas by clustering shops, then let AI name them.

DBSCAN on recommendable shops (Korea TM metres): shops within EPS_M of each other chain into one area; areas with at
least MIN_SHOPS shops become regions. Each region gets nearby subway stations (Kakao category search) and its most
common 행정동 names, which AI uses to pick a familiar name (성수, 홍대·연남 …). Re-running replaces all regions.

Usage: python -m pipeline.regions [--eps 150] [--min-points 20] [--min-shops 80]
"""

import argparse
import json
import urllib.parse
import urllib.request

from pydantic import BaseModel, Field

from ai import generate
from app.settings import settings
from pipeline.db import connect, pipeline_run

SYSTEM = """너는 서울 쇼핑 지역에 이름을 붙이는 도우미다. 옷가게가 모여 있는 구역마다 근처 지하철역, 행정동, 대표 가게 이름, 가게 종류 수를 준다.

- name: 서울 사람들이 쇼핑하러 갈 때 부르는 짧은 지역 이름. 예: 성수, 홍대·연남, 한남, 가로수길, 압구정로데오, 동묘, 명동, 동대문, 남대문, 이태원, 신촌·이대, 건대, 익선·종로3가, 천호, 잠실
  두 동네가 이어지면 가운뎃점(·)으로 잇는다. 6글자 안팎. 구 이름만 쓰지 않는다.
- intro: 그 지역 옷 쇼핑의 특징을 한국어 한 문장으로 (예: "빈티지 숍과 디자이너 편집숍이 골목마다 있는 동네"). 가게 종류 수를 근거로 쓴다. 지어내지 않는다.
- reason: 이름을 고른 근거를 짧게"""


class RegionName(BaseModel):
    region_key: int
    name: str
    intro: str
    reason: str = Field(description="근거, 짧게")


class RegionNames(BaseModel):
    regions: list[RegionName]


def nearby_stations(lon: float, lat: float, radius_m: int = 700) -> list[str]:
    q = urllib.parse.urlencode({"category_group_code": "SW8", "x": lon, "y": lat, "radius": radius_m, "sort": "distance"})
    req = urllib.request.Request(
        f"https://dapi.kakao.com/v2/local/search/category.json?{q}",
        headers={"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"},
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        docs = json.load(res)["documents"]
    names: list[str] = []
    for d in docs:
        station = d["place_name"].split(" ")[0]  # "성수역 2호선" → "성수역"
        if station not in names:
            names.append(station)
    return names[:4]


def run(eps: int, min_points: int, min_shops: int) -> dict:
    with connect() as conn, pipeline_run(conn, "regions") as stats:
        clusters = conn.execute(
            f"""
            WITH p AS (
                SELECT s.id, s.name, s.kind, s.category, ST_Transform(s.geom::geometry, 5179) AS g
                FROM shops s WHERE s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
            ), cl AS (
                SELECT *, ST_ClusterDBSCAN(g, eps := %s, minpoints := %s) OVER () AS cid FROM p
            )
            SELECT cid, count(*) AS n,
                   ST_AsText(ST_Transform(ST_Buffer(ST_ConcaveHull(ST_Collect(g), 0.3), 40), 4326)) AS poly,
                   ST_X(ST_Transform(ST_Centroid(ST_Collect(g)), 4326)), ST_Y(ST_Transform(ST_Centroid(ST_Collect(g)), 4326)),
                   array_agg(id) AS ids
            FROM cl WHERE cid IS NOT NULL GROUP BY cid HAVING count(*) >= %s ORDER BY n DESC""",
            (eps, min_points, min_shops),
        ).fetchall()

        regions = []
        for key, (_cid, n, poly, lon, lat, ids) in enumerate(clusters):
            counts = dict(conn.execute(
                "SELECT category, count(*) FROM shops WHERE id = ANY(%s) GROUP BY 1 ORDER BY 2 DESC", (ids,)
            ).fetchall())
            dongs = [r[0] for r in conn.execute(
                """SELECT payload->>'행정동명', count(*) FROM raw_sources
                   WHERE shop_id = ANY(%s) AND source = 'sbiz' GROUP BY 1 ORDER BY 2 DESC LIMIT 4""", (ids,)
            ).fetchall()]
            notable = [r[0] for r in conn.execute(
                """SELECT name FROM shops WHERE id = ANY(%s) AND category IN ('select_shop', 'vintage', 'complex', 'brand')
                   ORDER BY (category = 'complex') DESC, random() LIMIT 12""", (ids,)
            ).fetchall()]
            regions.append({
                "region_key": key, "shop_count": n, "polygon": poly, "lon": lon, "lat": lat,
                "category_counts": counts, "dongs": dongs, "stations": nearby_stations(lon, lat), "notable_shops": notable,
            })

        names: dict[int, RegionName] = {}
        for i in range(0, len(regions), 10):
            chunk = regions[i : i + 10]
            prompt = [{k: r[k] for k in ("region_key", "shop_count", "category_counts", "stations", "dongs", "notable_shops")} for r in chunk]
            result = generate(
                purpose="name_regions",
                system=SYSTEM,
                prompt="각 구역의 이름을 지어라.\n\n" + json.dumps(prompt, ensure_ascii=False, indent=1),
                schema=RegionNames,
                tier="smart",
                conn=conn,
                run_id=stats["run_id"],
            )
            names.update({r.region_key: r for r in result.regions})

        with conn.transaction():
            conn.execute("DELETE FROM regions")
            for r in regions:
                nm = names.get(r["region_key"])
                fallback = (r["stations"] or r["dongs"] or ["이름 없음"])[0].removesuffix("역")
                conn.execute(
                    """INSERT INTO regions (name, intro, name_reason, polygon, center, shop_count, category_counts, stations, dongs)
                       VALUES (%s, %s, %s, ST_GeogFromText(%s), ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s, %s, %s, %s)""",
                    (nm.name if nm else fallback, nm.intro if nm else None, nm.reason if nm else "AI 응답 없음",
                     r["polygon"], r["lon"], r["lat"], r["shop_count"], json.dumps(r["category_counts"]),
                     r["stations"], r["dongs"]),
                )
        stats["regions"] = [
            {"name": n, "shops": c} for n, c in conn.execute("SELECT name, shop_count FROM regions ORDER BY shop_count DESC")
        ]
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--eps", type=int, default=150)
    p.add_argument("--min-points", type=int, default=20)
    p.add_argument("--min-shops", type=int, default=80)
    a = p.parse_args()
    print(json.dumps(run(a.eps, a.min_points, a.min_shops), ensure_ascii=False, indent=2))
