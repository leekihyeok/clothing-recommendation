"""Pipeline step ⑥: check each scored shop against its evidence and set confidence 0-1.

A different model tier than the scorer reads the evidence next to the generated summary / top styles / reason and says
how well they are supported. That is combined with plain signals:
  - no evidence at all but listed on Kakao → 0.45 (exists, little known; shown as "정보가 적은 가게")
  - only in the public data (no Kakao) and no evidence → capped at 0.25 (likely closed)
  - newest post older than 2 years     → × 0.7
Confidence ranks shops in recommendations; nothing is hidden here.

Usage: python -m pipeline.verify [--region 성수] [--limit 100] [--batch 8]
"""

import argparse
import json
from datetime import date

from pydantic import BaseModel, Field

from ai import generate
from pipeline.db import connect, pipeline_run

SYSTEM = """너는 옷가게 소개 글을 엄격하게 검수하는 사람이다. 가게마다 근거(블로그·웹문서·카페 글의 제목·요약, 영상 제목)와,
다른 AI가 쓴 소개(summary), 상위 스타일 점수, 들를 이유(reason_material)를 준다.

support: 소개·스타일·이유가 근거로 뒷받침되는 정도 0~1.
  1.0  이 가게를 직접 다룬 글이 있고, 소개의 구체적 내용(예: 리바이스 데님, 축구 유니폼)이 근거에 그대로 있음
  0.7  이 가게를 직접 다룬 글은 있지만 소개 일부가 일반적이거나 추정
  0.5  여러 가게를 나열한 목록 글, 팝업 일정, 동네 산책기 속에 이름만 나옴 (이 가게 자체의 설명은 거의 없음)
  0.3  근거가 거의 없어 소개 대부분이 가게 종류·이름에서 나온 추정
  0.0  근거와 어긋나거나, 근거가 다른 가게(같은 이름의 다른 곳, 식당·카페 등) 이야기
근거가 비어 있으면 0.3 이하. 후하게 주지 않는다.
note: 문제가 있으면 무엇이 근거 없는지 짧게, 없으면 "ok"."""


class Check(BaseModel):
    shop_id: int
    support: float = Field(ge=0, le=1)
    note: str


class Checks(BaseModel):
    shops: list[Check]


def combine(support: float, posts: int, has_kakao: bool, last_post: date | None, today: date) -> float:
    c = support
    if posts == 0:
        # No posts found is not evidence against a shop that Kakao lists: it exists, we just know little about it.
        # Only a public-data-only shop with no trace anywhere is likely gone.
        c = 0.45 if has_kakao else min(c, 0.25)
    if last_post and (today - last_post).days > 730:
        c *= 0.7
    return round(c, 2)


def run(region: str | None, limit: int | None, batch: int, categories: list[str] | None = None) -> dict:
    with connect() as conn, pipeline_run(conn, "verify") as stats:
        sql = """SELECT s.id, s.name, s.summary, s.reason_material, coalesce(s.matched_posts, 0), s.last_mention_on,
                        EXISTS (SELECT 1 FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao')
                 FROM shops s WHERE s.scored_at IS NOT NULL AND s.confidence IS NULL"""
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
        rows = conn.execute(sql, params).fetchall()
        meta = {r[0]: r for r in rows}
        stats.update(region=region, shops=len(rows), verified=0)
        today = date.today()
        for i in range(0, len(rows), batch):
            chunk = []
            for sid, name, summary, reason, _, _, _ in rows[i : i + batch]:
                top = conn.execute(
                    "SELECT style_id, score FROM shop_style_scores WHERE shop_id = %s AND score >= 5 ORDER BY score DESC LIMIT 3",
                    (sid,),
                ).fetchall()
                posts = conn.execute(
                    """SELECT kind, title, snippet FROM shop_facts WHERE shop_id = %s
                       ORDER BY (kind = 'blog_post') DESC, posted_on DESC NULLS LAST LIMIT 8""",
                    (sid,),
                ).fetchall()
                chunk.append({
                    "shop_id": sid, "name": name, "summary": summary, "reason_material": reason,
                    "top_styles": [f"{s}:{v}" for s, v in top],
                    "evidence": [{"type": k, "title": t, "snippet": s} for k, t, s in posts],
                })
            result = generate(
                purpose="verify_shops",
                system=SYSTEM,
                prompt="각 가게의 소개를 검수해라.\n\n" + json.dumps(chunk, ensure_ascii=False),
                schema=Checks,
                tier="check",
                conn=conn,
                run_id=stats["run_id"],
            )
            for c in result.shops:
                if c.shop_id not in meta:
                    continue
                _, _, _, _, posts, last, has_kakao = meta[c.shop_id]
                conf = combine(c.support, posts, has_kakao, last, today)
                conn.execute(
                    "UPDATE shops SET confidence = %s, verify_note = coalesce(verify_note, '') || ' | ' || %s WHERE id = %s",
                    (conf, c.note, c.shop_id),
                )
                stats["verified"] += 1
            conn.commit()
            print(f"  {min(i + batch, len(rows))}/{len(rows)}", flush=True)
        stats["confidence"] = dict(conn.execute(
            """SELECT CASE WHEN confidence >= 0.6 THEN 'high' WHEN confidence >= 0.35 THEN 'mid' ELSE 'low' END, count(*)
               FROM shops WHERE confidence IS NOT NULL GROUP BY 1"""
        ).fetchall())
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    p.add_argument("--batch", type=int, default=8)
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit, a.batch), ensure_ascii=False, indent=2))
