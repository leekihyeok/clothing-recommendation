"""Pipeline step ①-b: sweep Seoul with Kakao Local keyword search to catch shops missing from the public data.

Kakao returns at most 45 places per query (3 pages × 15), so each cell is split into four until a query fits.
Places land in raw_sources (source = 'kakao'); the dedupe step merges them with shops.

Usage: python -m pipeline.kakao [--keywords 의류판매,신발] [--max-requests 20000]
"""

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from app.settings import settings
from pipeline.db import connect, pipeline_run

URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
SEOUL_BBOX = (126.76, 37.41, 127.19, 37.72)  # min lon, min lat, max lon, max lat
START_CELL_DEG = 0.02  # ~1.8 km × 2.2 km
MIN_CELL_DEG = 0.0005  # ~50 m: stop splitting even if still over 45 (dense malls)
PAGE_LIMIT = 45
REQUEST_GAP_S = 0.12

KEYWORDS = ["의류판매", "신발", "가방", "편집샵", "빈티지"]

# Kakao categories we keep. Glasses, watches, jewelry and cosmetics also sit under 패션 and are dropped.
KEEP_PREFIXES = ("가정,생활 > 패션 > 의류판매", "가정,생활 > 패션 > 패션잡화점 > 구두,신발", "가정,생활 > 패션 > 패션잡화점 > 가방")
KEEP_EXACT = {"가정,생활 > 패션", "가정,생활 > 패션 > 패션잡화점", "가정,생활 > 중고용품 > 중고의류"}


def keep_place(doc: dict) -> bool:
    cat = doc.get("category_name") or ""
    addr = doc.get("address_name") or doc.get("road_address_name") or ""
    return addr.startswith("서울") and (cat in KEEP_EXACT or cat.startswith(KEEP_PREFIXES))


@dataclass
class Cell:
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float

    @property
    def rect(self) -> str:
        return f"{self.min_lon:.6f},{self.min_lat:.6f},{self.max_lon:.6f},{self.max_lat:.6f}"

    def split(self) -> list["Cell"]:
        mx, my = (self.min_lon + self.max_lon) / 2, (self.min_lat + self.max_lat) / 2
        return [
            Cell(self.min_lon, self.min_lat, mx, my),
            Cell(mx, self.min_lat, self.max_lon, my),
            Cell(self.min_lon, my, mx, self.max_lat),
            Cell(mx, my, self.max_lon, self.max_lat),
        ]


class Kakao:
    def __init__(self, max_requests: int):
        if not settings.kakao_rest_api_key:
            raise RuntimeError("KAKAO_REST_API_KEY is not set (.env)")
        self.max_requests = max_requests
        self.requests = 0

    def search(self, query: str, cell: Cell, page: int) -> dict:
        if self.requests >= self.max_requests:
            raise RuntimeError(f"request budget of {self.max_requests} used up")
        q = urllib.parse.urlencode({"query": query, "rect": cell.rect, "page": page, "size": 15})
        req = urllib.request.Request(f"{URL}?{q}", headers={"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"})
        for attempt in range(5):
            time.sleep(REQUEST_GAP_S)
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    return json.load(res)
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise RuntimeError(f"Kakao {e.code}: {e.read().decode(errors='replace')}") from e
            except urllib.error.URLError:
                time.sleep(5 * (attempt + 1))
        raise RuntimeError("Kakao: repeated failures")


def sweep(kakao: Kakao, query: str, on_places) -> dict:
    stats = {"cells": 0, "capped_cells": 0, "places_seen": 0}
    min_lon, min_lat, max_lon, max_lat = SEOUL_BBOX
    stack = []
    lon = min_lon
    while lon < max_lon:
        lat = min_lat
        while lat < max_lat:
            stack.append(Cell(lon, lat, min(lon + START_CELL_DEG, max_lon), min(lat + START_CELL_DEG, max_lat)))
            lat += START_CELL_DEG
        lon += START_CELL_DEG
    while stack:
        cell = stack.pop()
        first = kakao.search(query, cell, 1)
        total = first["meta"]["total_count"]
        if total == 0:
            continue
        if total > PAGE_LIMIT and (cell.max_lon - cell.min_lon) > MIN_CELL_DEG:
            stack.extend(cell.split())
            continue
        if total > PAGE_LIMIT:
            stats["capped_cells"] += 1
        stats["cells"] += 1
        docs = list(first["documents"])
        page = 1
        while not (first if page == 1 else res)["meta"]["is_end"] and page < 3:
            page += 1
            res = kakao.search(query, cell, page)
            docs.extend(res["documents"])
        stats["places_seen"] += len(docs)
        on_places(docs)
    return stats


def run(keywords: list[str], max_requests: int) -> dict:
    kakao = Kakao(max_requests)
    with connect() as conn, pipeline_run(conn, "kakao_grid") as stats:
        stats["keywords"] = {}

        def save(docs: list[dict]) -> None:
            kept = [d for d in docs if keep_place(d)]
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO raw_sources (source, source_id, name, category_name, address, road_address, geom, payload)
                       VALUES ('kakao', %s, %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
                       ON CONFLICT (source, source_id) DO UPDATE SET
                           name = EXCLUDED.name, category_name = EXCLUDED.category_name, address = EXCLUDED.address,
                           road_address = EXCLUDED.road_address, geom = EXCLUDED.geom, payload = EXCLUDED.payload,
                           fetched_at = now()""",
                    [
                        (d["id"], d["place_name"], d["category_name"], d["address_name"] or None,
                         d["road_address_name"] or None, float(d["x"]), float(d["y"]), json.dumps(d, ensure_ascii=False))
                        for d in kept
                    ],
                )
            conn.commit()

        for kw in keywords:
            started = kakao.requests
            stats["keywords"][kw] = sweep(kakao, kw, save)
            stats["keywords"][kw]["requests"] = kakao.requests - started
            print(f"  {kw}: {stats['keywords'][kw]}")
        stats["requests"] = kakao.requests
        stats["kakao_places"] = conn.execute("SELECT count(*) FROM raw_sources WHERE source = 'kakao'").fetchone()[0]
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--keywords", default=",".join(KEYWORDS))
    p.add_argument("--max-requests", type=int, default=30000)
    a = p.parse_args()
    print(json.dumps(run(a.keywords.split(","), a.max_requests), ensure_ascii=False, indent=2))
