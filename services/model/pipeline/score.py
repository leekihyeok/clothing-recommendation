"""Pipeline step ⑤: score each shop on the shared style list, from its blog evidence.

AI sees the shop's name, category, area and the blog titles/snippets collected by pipeline.blogs, and returns 0-10 per
style, items sold, price range, a one-line summary and a "why go" line. It is told to use only the evidence; shops with
no evidence get cautious scores and evidence = 'none', which the verify step turns into low confidence.

Usage: python -m pipeline.score [--region 성수] [--limit 100] [--rescore] [--batch 8]
"""

import argparse
import json
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

from ai import generate
from app.catalog import load_catalog
from pipeline.db import connect, pipeline_run

CATALOG = load_catalog()
StyleId = Enum("StyleId", {s.id: s.id for s in CATALOG.styles}, type=str)
ItemId = Enum("ItemId", {i.id: i.id for i in CATALOG.items}, type=str)

SYSTEM = f"""너는 서울 옷가게를 소개하는 에디터다. 가게마다 이름, 종류, 동네, 근거(블로그·웹문서·카페 글의 제목·요약, 유튜브 등 영상 제목)를 준다.
근거에 있는 내용만 쓴다. 근거가 없거나 다른 가게 이야기면 지어내지 않는다.

스타일 목록(id: 이름): {", ".join(f"{s.id}: {s.label}" for s in CATALOG.styles)}
품목 목록(id: 이름): {", ".join(f"{i.id}: {i.label}" for i in CATALOG.items)}

- styles: 목록의 모든 스타일에 0~10점. 근거가 뚜렷하면 7~10, 약하면 3~6, 관련 없으면 0~2. 근거가 없으면 가게 종류·이름으로 추정하되 6점을 넘기지 않는다.
  reason은 점수가 5 이상인 스타일에만 짧게 쓴다.
- items: 파는 품목 id (근거나 가게 종류로 알 수 있는 것만)
- price_range: low(1~5만원대 위주) | mid | high(명품·디자이너 고가) | unknown
- gender: 누구 옷을 파나. men(남성복 위주) | women(여성복 위주) | unisex(남녀 모두) | unknown(근거에 없으면)
- summary: 카드에 보일 한 줄 소개, 30자 안팎, 광고 문구 말고 사실만. 예: "90년대 미국 빈티지 데님과 워크웨어"
- reason_material: 이 가게에 들를 이유 한 가지, 25자 안팎. 예: "리바이스 빈티지 데님이 많음"
- evidence: enough(이 가게를 직접 다룬 글이 여럿) | thin(한두 개거나 내용이 얕음) | none(근거 없음)"""


class StyleScore(BaseModel):
    style: StyleId
    score: int = Field(ge=0, le=10)
    reason: str | None = None


class ShopScore(BaseModel):
    shop_id: int
    styles: list[StyleScore]
    items: list[ItemId]
    price_range: Literal["low", "mid", "high", "unknown"]
    gender: Literal["men", "women", "unisex", "unknown"] = "unknown"
    summary: str
    reason_material: str
    evidence: Literal["enough", "thin", "none"]


class ShopScores(BaseModel):
    shops: list[ShopScore]


def load(conn, region: str | None, limit: int | None, rescore: bool, categories: list[str] | None = None) -> list[dict]:
    sql = """SELECT s.id, s.name, s.category, coalesce(s.road_address, s.address), s.in_market, s.matched_posts,
                    (SELECT category_name FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' LIMIT 1)
             FROM shops s
             WHERE s.kind = 'store' AND s.status = 'candidate' AND s.category <> 'excluded' AND s.evidence_at IS NOT NULL"""
    params: list = []
    if not rescore:
        sql += " AND s.scored_at IS NULL"
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
    shops = []
    for sid, name, category, address, in_market, matched, kakao in conn.execute(sql, params).fetchall():
        posts = conn.execute(
            """SELECT kind, title, snippet, posted_on FROM shop_facts WHERE shop_id = %s
               ORDER BY (kind = 'blog_post') DESC, posted_on DESC NULLS LAST LIMIT 8""",
            (sid,),
        ).fetchall()
        shops.append({
            "shop_id": sid, "name": name, "category": category, "kakao_category": kakao, "address": address,
            "in_market": in_market,
            "evidence": [{"type": k, "title": t, "snippet": s, "date": str(d) if d else None} for k, t, s, d in posts],
        })
    return shops


def save(conn, s: ShopScore) -> None:
    conn.execute("DELETE FROM shop_style_scores WHERE shop_id = %s", (s.shop_id,))
    seen = set()
    for st in s.styles:
        if st.style.value in seen:
            continue
        seen.add(st.style.value)
        conn.execute(
            "INSERT INTO shop_style_scores (shop_id, style_id, score, reason) VALUES (%s, %s, %s, %s)",
            (s.shop_id, st.style.value, st.score, st.reason if st.score >= 5 else None),
        )
    conn.execute(
        """UPDATE shops SET items = %s, price_range = %s, summary = %s, reason_material = %s, scored_at = now(),
               verify_note = %s, confidence = NULL,
               gender = coalesce(gender, %s::text), gender_source = CASE WHEN gender IS NULL AND %s::text IS NOT NULL THEN 'ai' ELSE gender_source END
           WHERE id = %s""",
        ([i.value for i in s.items], s.price_range, s.summary, s.reason_material, f"evidence:{s.evidence}",
         None if s.gender == "unknown" else s.gender, None if s.gender == "unknown" else s.gender, s.shop_id),
    )


def run(region: str | None, limit: int | None, rescore: bool, batch: int, categories: list[str] | None = None) -> dict:
    with connect() as conn, pipeline_run(conn, "score") as stats:
        shops = load(conn, region, limit, rescore, categories)
        stats.update(region=region, shops=len(shops), scored=0, evidence={})
        for i in range(0, len(shops), batch):
            chunk = shops[i : i + batch]
            result = generate(
                purpose="score_shops",
                system=SYSTEM,
                prompt="각 가게를 채점해라.\n\n" + json.dumps(chunk, ensure_ascii=False),
                schema=ShopScores,
                tier="fast",
                conn=conn,
                run_id=stats["run_id"],
            )
            asked = {s["shop_id"] for s in chunk}
            for s in result.shops:
                if s.shop_id in asked:
                    save(conn, s)
                    stats["scored"] += 1
                    stats["evidence"][s.evidence] = stats["evidence"].get(s.evidence, 0) + 1
            conn.commit()
            print(f"  {min(i + batch, len(shops))}/{len(shops)}", flush=True)
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    p.add_argument("--rescore", action="store_true")
    p.add_argument("--batch", type=int, default=8)
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit, a.rescore, a.batch), ensure_ascii=False, indent=2))
