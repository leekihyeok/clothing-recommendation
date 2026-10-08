"""Pipeline step: re-check a shop's category once its evidence is in.

Step ③ classified most shops from the name alone, before any posts were read. Step ⑤ then wrote a summary and style
scores from the posts — and sometimes they plainly say another category: "오티코티" was 'brand' while its posts make
it a 90s American vintage shop (vintage 10). Here those are corrected:
   - vintage      the summary says it sells used / vintage goods (빈티지 의류·샵, 구제, 중고, 세컨핸드) and the vintage or
                 secondhand score is 6+ — a brand with a vintage look ("빈티지 시크 브랜드") is not a vintage shop
  - select_shop  a 'general' shop whose summary calls it a 편집숍 / 셀렉트숍
Only categories the AI guessed from the name (category_source 'ai') are touched; rule results (SPA names, Kakao's
own brand category) and manual ones stay. Changed shops get category_source 'evidence', so later runs leave them be.

Usage: python -m pipeline.recheck_category [--dry-run] [--region 성수]
"""

import argparse
import json

from pipeline.db import connect, pipeline_run

# Selling used / vintage goods, not a brand with a vintage look ("빈티지 시크 브랜드", "코닥 감성" stay brands).
VINTAGE_WORDS = r"빈티지\s*(샵|숍|상점|매장|의류|가게|스토어|전문|옷|셀렉)|구제|세컨핸드|중고"
SELECT_WORDS = "편집숍|편집샵|셀렉트숍|셀렉트샵|멀티숍|멀티샵"
NOT_CLOTHES = "뷰티|화장품|코스메틱"


def run(dry_run: bool, region: str | None = None) -> dict:
    with connect() as conn, pipeline_run(conn, "recheck_category") as stats:
        in_region = "" if not region else "AND EXISTS (SELECT 1 FROM regions g WHERE g.name = %(r)s AND ST_Intersects(g.polygon, s.geom))"
        rows = conn.execute(
            f"""WITH sc AS (
                  SELECT shop_id, max(score) FILTER (WHERE style_id IN ('vintage', 'secondhand')) AS vint FROM shop_style_scores GROUP BY shop_id
                )
                SELECT s.id, s.name, s.category, s.summary,
                       CASE
                         WHEN s.category IN ('brand', 'general', 'select_shop') AND s.summary ~ %(v)s AND coalesce(sc.vint, 0) >= 6
                              THEN 'vintage'
                         WHEN s.category = 'general' AND s.summary ~ %(sel)s AND s.summary !~ %(nc)s THEN 'select_shop'
                       END AS better
                FROM shops s LEFT JOIN sc ON sc.shop_id = s.id
                WHERE s.status = 'candidate' AND s.kind = 'store' AND s.category_source = 'ai' AND s.scored_at IS NOT NULL {in_region}""",
            {"v": VINTAGE_WORDS, "sel": SELECT_WORDS, "nc": NOT_CLOTHES, "r": region},
        ).fetchall()
        changes = [(i, n, old, new, summ) for i, n, old, summ, new in rows if new and new != old]
        stats.update(checked=len(rows), changed=len(changes), by_change={}, examples=[])
        for _, name, old, new, summary in changes:
            key = f"{old}→{new}"
            stats["by_change"][key] = stats["by_change"].get(key, 0) + 1
            if len(stats["examples"]) < 30:
                stats["examples"].append(f"{name}: {old}→{new} ({(summary or '')[:40]})")
        if dry_run:
            return stats
        for shop_id, _, old, new, _ in changes:
            conn.execute(
                "UPDATE shops SET category = %s, category_source = 'evidence', category_reason = %s WHERE id = %s",
                (new, f"근거로 다시 확인: {old}→{new}", shop_id),
            )
        conn.commit()
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--region")
    a = p.parse_args()
    print(json.dumps(run(a.dry_run, a.region), ensure_ascii=False, indent=2))
