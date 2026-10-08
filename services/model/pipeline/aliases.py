"""Pipeline step ④-b: for shops no search found anything about, ask AI for other names bloggers might use
(English spelling, Korean reading of an English name, word order), then search again with them.

Only shops that are on Kakao (so they exist) are asked; a public-data-only shop with no trace is likely closed.

Usage: python -m pipeline.aliases [--region 성수] [--limit 200]
"""

import argparse
import json

from pydantic import BaseModel, Field

from ai import generate
from pipeline import blogs
from pipeline.db import connect, pipeline_run

SYSTEM = """너는 서울 옷가게 이름을 아는 사람이다. 가게 이름으로 블로그를 검색했더니 아무것도 나오지 않았다.
블로거들이 이 가게를 다르게 부를 만한 이름을 최대 3개 준다.

- 영문 이름의 한글 표기, 한글 이름의 영문 표기 (예: 빈티지에어 → AIR VINTAGE, 에어빈티지)
- 단어 순서가 바뀐 이름, 띄어쓰기가 다른 이름
- 회사명·지점명을 뺀 짧은 이름
확실하지 않으면 빈 목록. 다른 가게 이름을 지어내지 않는다. 원래 이름과 같은 것은 넣지 않는다."""


class ShopAliases(BaseModel):
    shop_id: int
    aliases: list[str] = Field(max_length=3)


class Aliases(BaseModel):
    shops: list[ShopAliases]


def run(region: str | None, limit: int | None, batch: int = 40, categories: list[str] | None = None) -> dict:
    with connect() as conn, pipeline_run(conn, "aliases") as stats:
        sql = """SELECT s.id, s.name, array_agg(r.name), s.category, coalesce(s.road_address, s.address)
                 FROM shops s JOIN raw_sources r ON r.shop_id = s.id AND r.source = 'kakao'
                 WHERE s.kind = 'store' AND s.status = 'candidate' AND s.category <> 'excluded'
                   AND s.evidence_at IS NOT NULL AND coalesce(s.matched_posts, 0) = 0 AND s.aliases IS NULL"""
        params: list = []
        if region:
            sql += " AND EXISTS (SELECT 1 FROM regions g WHERE g.name = %s AND ST_Intersects(g.polygon, s.geom))"
            params.append(region)
        if categories:
            sql += " AND s.category = ANY(%s)"
            params.append(categories)
        sql += " GROUP BY s.id ORDER BY s.id"
        if limit:
            sql += " LIMIT %s"
            params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        stats.update(region=region, shops=len(rows), with_aliases=0)
        for i in range(0, len(rows), batch):
            chunk = rows[i : i + batch]
            result = generate(
                purpose="shop_aliases",
                system=SYSTEM,
                prompt="각 가게의 다른 이름을 줘라.\n\n" + json.dumps(
                    [{"shop_id": r[0], "name": r[1], "kakao_names": r[2], "category": r[3], "address": r[4]} for r in chunk],
                    ensure_ascii=False,
                ),
                schema=Aliases,
                tier="fast",
                conn=conn,
                run_id=stats["run_id"],
            )
            known = {r[0]: {r[1], *r[2]} for r in chunk}
            answered = set()
            for a in result.shops:
                if a.shop_id not in known:
                    continue
                names = [n.strip() for n in a.aliases if n.strip() and n.strip() not in known[a.shop_id]][:3]
                answered.add(a.shop_id)
                # Store [] too, so the shop isn't asked again. Shops with aliases get searched again.
                conn.execute(
                    """UPDATE shops SET aliases = %s, evidence_at = CASE WHEN %s THEN NULL ELSE evidence_at END
                       WHERE id = %s""",
                    (names, bool(names), a.shop_id),
                )
                stats["with_aliases"] += bool(names)
            for sid in known.keys() - answered:
                conn.execute("UPDATE shops SET aliases = '{}' WHERE id = %s", (sid,))
            conn.commit()
            print(f"  {min(i + batch, len(rows))}/{len(rows)}", flush=True)
        stats["research"] = blogs.run(region, None, 30)["with_evidence"] if stats["with_aliases"] else 0
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit), ensure_ascii=False, indent=2))
