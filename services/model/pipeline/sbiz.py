"""Pipeline step ①: import clothing retail rows from the 공공데이터 상가(상권)정보 CSV into raw_sources.

Usage: python -m pipeline.sbiz data/raw/sbiz_stores_seoul_202606.csv
"""

import csv
import json
import re
import sys
from pathlib import Path

from app.settings import REPO_ROOT
from pipeline.db import connect, pipeline_run

# 상권업종소분류코드 kept as clothing candidates. 수선(S20601), 대여(N11004), 유아복(G20903), 한복(G20904) are left out.
CLOTHING_CODES = {
    "G20901": "남성 의류",
    "G20902": "여성 의류",
    "G20905": "기타 의류",
    "G20907": "액세서리/잡화",
    "G20910": "신발",
    "G20911": "가방",
    "G22201": "중고 상품",  # 구제샵 후보, but also used phones/appliances — filtered by name below
}

# 중고 상품 rows whose names say they sell something other than clothes.
NON_CLOTHING_USED = re.compile(
    r"폰|휴대|핸드폰|모바일|전자|가전|컴퓨터|노트북|PC|냉동|냉장|에어컨|가구|주방|사무|기계|공구|자동차|카메라|골프|자전거|악기|피아노|도서|책방|서적|서점|전기|자원|고물|그릇|재활용|리사이클링|바이닐|레코드|미디어|화장품",
    re.IGNORECASE,
)


def is_candidate(row: dict) -> bool:
    code = row["상권업종소분류코드"]
    if code not in CLOTHING_CODES:
        return False
    if code == "G22201" and NON_CLOTHING_USED.search(row["상호명"]):
        return False
    return bool(row["경도"] and row["위도"])


def source_version(path: Path) -> str | None:
    m = re.search(r"(\d{6})", path.stem)
    return m.group(1) if m else None


def import_csv(path: Path) -> dict:
    version = source_version(path)
    with connect() as conn, pipeline_run(conn, "import_sbiz") as stats:
        stats.update(file=path.name, version=version, rows=0, candidates=0, skipped_used=0)
        with open(path, encoding="utf-8-sig", newline="") as f, conn.cursor() as cur:
            batch = []
            for row in csv.DictReader(f):
                stats["rows"] += 1
                if row["상권업종소분류코드"] == "G22201" and NON_CLOTHING_USED.search(row["상호명"]):
                    stats["skipped_used"] += 1
                if not is_candidate(row):
                    continue
                stats["candidates"] += 1
                batch.append((
                    row["상가업소번호"], version, row["상호명"], row["지점명"] or None,
                    row["상권업종소분류코드"], row["상권업종소분류명"],
                    row["지번주소"] or None, row["도로명주소"] or None,
                    row["건물관리번호"] or None, row["건물명"] or None, row["층정보"] or None,
                    float(row["경도"]), float(row["위도"]), json.dumps(row, ensure_ascii=False),
                ))
                if len(batch) >= 2000:
                    _upsert(cur, batch)
                    batch.clear()
            _upsert(cur, batch)
        # Rows from an older file that are gone from this one are closed or moved; flag them for the dedupe step.
        stats["missing_from_this_version"] = conn.execute(
            "SELECT count(*) FROM raw_sources WHERE source = 'sbiz' AND source_version IS DISTINCT FROM %s", (version,)
        ).fetchone()[0]
    return stats


def _upsert(cur, batch: list[tuple]) -> None:
    if not batch:
        return
    cur.executemany(
        """
        INSERT INTO raw_sources (source, source_id, source_version, name, branch, category_code, category_name,
                                 address, road_address, building_id, building_name, floor, geom, payload)
        VALUES ('sbiz', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
        ON CONFLICT (source, source_id) DO UPDATE SET
            source_version = EXCLUDED.source_version, name = EXCLUDED.name, branch = EXCLUDED.branch,
            category_code = EXCLUDED.category_code, category_name = EXCLUDED.category_name,
            address = EXCLUDED.address, road_address = EXCLUDED.road_address,
            building_id = EXCLUDED.building_id, building_name = EXCLUDED.building_name, floor = EXCLUDED.floor,
            geom = EXCLUDED.geom, payload = EXCLUDED.payload, fetched_at = now()
        """,
        batch,
    )


if __name__ == "__main__":
    arg = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/raw/sbiz_stores_seoul_202606.csv")
    result = import_csv(arg if arg.is_absolute() else REPO_ROOT / arg)
    print(json.dumps(result, ensure_ascii=False, indent=2))
