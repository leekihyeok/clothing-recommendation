"""Pipeline step: blog reputation for the shop detail page.

For shops with posts that clearly mention them (step ④), AI reads the post titles and snippets and says how positively
they talk about the shop (1-5) and a few short pros / cons. Shown next to our own reviews as "블로그 평판", never mixed
into them silently: the page shows both and how many posts the reputation rests on. Kakao Map / Naver ratings are not
collected (no public API; copying them breaks their terms).

Usage: python -m pipeline.reputation [--region 성수] [--limit 100] [--batch 10]
"""

import argparse
import json

from pydantic import BaseModel, Field

from ai import generate
from pipeline.db import connect, pipeline_run

SYSTEM = """너는 옷가게 후기를 정리하는 에디터다. 가게마다 블로그·카페 글의 제목과 요약 몇 개를 준다.

- score: 글들이 이 가게를 얼마나 좋게 말하는지 1~5 (소수 한 자리). 칭찬이 대부분이면 4.5 이상, 칭찬과 아쉬움이 섞이면 3.5 안팎,
  불만이 많으면 2 이하. 가게 소개만 하고 평가가 없는 글이 대부분이면 3.5.
- pros / cons: 글에 실제로 나온 장점·아쉬운 점을 짧은 말로 0~3개씩 (예: "가격이 착함", "사장님이 친절함", "사이즈가 적음").
  글에 없는 내용은 쓰지 않는다. 다른 가게 이야기, 광고 문구는 무시한다."""


class Rep(BaseModel):
    shop_id: int
    score: float = Field(ge=1, le=5)
    pros: list[str] = Field(default_factory=list, max_length=3)
    cons: list[str] = Field(default_factory=list, max_length=3)


class Reps(BaseModel):
    shops: list[Rep]


def run(region: str | None, limit: int | None, batch: int, categories: list[str] | None = None) -> dict:
    with connect() as conn, pipeline_run(conn, "reputation") as stats:
        sql = """SELECT s.id, s.name FROM shops s
                 WHERE s.status = 'candidate' AND coalesce(s.matched_posts, 0) > 0 AND s.evidence_at IS NOT NULL
                   AND (s.reputation_at IS NULL OR s.reputation_at < s.evidence_at)"""
        params: list = []
        if region:
            sql += " AND EXISTS (SELECT 1 FROM regions g WHERE g.name = %s AND ST_Intersects(g.polygon, s.geom))"
            params.append(region)
        if categories:
            sql += " AND s.category = ANY(%s)"
            params.append(categories)
        sql += " ORDER BY s.id"
        if limit:
            sql += " LIMIT %s"
            params.append(limit)
        shops = conn.execute(sql, params).fetchall()
        stats.update(region=region, shops=len(shops), done=0)
        for i in range(0, len(shops), batch):
            chunk = []
            for shop_id, name in shops[i : i + batch]:
                posts = conn.execute(
                    """SELECT title, left(snippet, 220) FROM shop_facts WHERE shop_id = %s
                       ORDER BY (kind = 'blog_post') DESC, posted_on DESC NULLS LAST LIMIT 6""",
                    (shop_id,),
                ).fetchall()
                chunk.append({"shop_id": shop_id, "name": name, "posts": [{"title": t, "snippet": s} for t, s in posts]})
            result = generate(
                purpose="shop_reputation", system=SYSTEM,
                prompt="각 가게의 블로그 평판을 정리해라.\n\n" + json.dumps(chunk, ensure_ascii=False),
                schema=Reps, tier="fast", conn=conn, run_id=stats["run_id"],
            )
            asked = {c["shop_id"] for c in chunk}
            for r in result.shops:
                if r.shop_id not in asked:
                    continue
                conn.execute(
                    "UPDATE shops SET blog_score = %s, blog_pros = %s, blog_cons = %s, reputation_at = now() WHERE id = %s",
                    (round(r.score, 1), [p[:30] for p in r.pros], [c[:30] for c in r.cons], r.shop_id),
                )
                stats["done"] += 1
            conn.commit()
            print(f"  {min(i + batch, len(shops))}/{len(shops)}", flush=True)
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    p.add_argument("--batch", type=int, default=10)
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit, a.batch), ensure_ascii=False, indent=2))
