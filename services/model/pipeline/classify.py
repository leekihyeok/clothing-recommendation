"""Pipeline step ③: classify each store. Rules first (Kakao sub-category, name keywords), AI for the rest.

Categories:
  select_shop  편집숍 (several brands, curated)
  vintage      빈티지·구제
  brand        single-brand store (LF, MLB, Nike …)
  spa          SPA chain (유니클로, 탑텐, 자라 …)
  general      neighborhood boutique / 보세 / discount clothing store
  excluded     not a walk-in fashion shop for this service (한복·단체복·무용복·속옷, wholesale, tailoring-only, office …)

Usage: python -m pipeline.classify [--rules-only] [--limit N] [--batch 40]
"""

import argparse
import json
import re
from typing import Literal

from pydantic import BaseModel, Field

from ai import generate
from pipeline.db import connect, pipeline_run

Category = Literal["select_shop", "vintage", "brand", "spa", "general", "excluded"]

# Decided 2026-10-07: 한복·단체복·무용복, 속옷 are out; 아동복 and 양복점 stay (AI drops tailoring-only shops).
EXCLUDED_KAKAO = re.compile(r"한복|단체복|유니폼|무용복|속옷|언더웨어")
EXCLUDED_NAME = re.compile(
    r"한복|단체복|유니폼|무용복|발레복|속옷|언더웨어|란제리|BYC|비비안|트라이\b|제임스딘|좋은사람들|원더브라|와코루|에탐|보디가드|섹시쿠키"
    r"|양말|인따르시아|내의(?!류)|도매|수선|세탁|대여"
)
SPA_NAME = re.compile(
    r"유니클로|UNIQLO|스파오|SPAO|탑텐|TOPTEN|자라|ZARA|H&M|에이치앤엠|에잇세컨즈|8SECONDS|무신사\s*스탠다드|미쏘(?!니)|MIXXO|지오다노|GIORDANO|\bCOS\b|\bMANGO\b|폴햄키즈",
    re.IGNORECASE,
)
VINTAGE_NAME = re.compile(r"빈티지|구제|VINTAGE|세컨핸드|SECONDHAND|중고의류|아메카지|리사이클", re.IGNORECASE)
SELECT_NAME = re.compile(r"편집샵|편집숍|셀렉트샵|셀렉샵|SELECT\s*SHOP|멀티샵|멀티숍", re.IGNORECASE)
# Kakao 4th-level categories that describe a kind of clothing rather than a brand.
GENERIC_KAKAO_SUB = {
    "", "여성의류", "남성의류,양복", "스포츠의류", "아동복,유아복", "구두,신발", "가방", "가죽,모피", "수입의류",
    "한복", "단체복,유니폼", "속옷,언더웨어", "무용복", "등산복", "임부복", "빅사이즈", "모자", "양말", "넥타이",
}


class Fact(BaseModel):
    shop_id: int
    name: str
    kakao_category: str | None
    public_category: str | None
    address: str | None
    in_market: bool
    building_kind: str | None


# Public-data 중고 상품 rows that Kakao doesn't list as clothing: mostly used furniture, scrap, appliances (eval v1 #29).
CLOTHING_HINT = re.compile(r"빈티지|구제|VINTAGE|세컨|의류|옷|패션|밀리터리|명품|가방|신발|아메카지", re.IGNORECASE)


def rule_category(f: Fact) -> tuple[Category, str] | None:
    kakao = f.kakao_category or ""
    if EXCLUDED_KAKAO.search(kakao):
        return "excluded", f"카카오 분류: {kakao}"
    if EXCLUDED_NAME.search(f.name):
        return "excluded", "이름에 제외 키워드"
    if f.public_category == "중고 상품 소매업" and f.kakao_category is None and not CLOTHING_HINT.search(f.name):
        return "excluded", "의류 단서 없는 중고 상품점"
    if SPA_NAME.search(f.name):
        return "spa", "SPA 브랜드 이름"
    if VINTAGE_NAME.search(f.name) or "중고의류" in kakao:
        return "vintage", "이름 또는 분류에 빈티지·구제"
    if SELECT_NAME.search(f.name):
        return "select_shop", "이름에 편집숍"
    parts = kakao.split(" > ")
    if len(parts) >= 4 and parts[3] not in GENERIC_KAKAO_SUB:
        return "brand", f"카카오 브랜드 분류: {parts[3]}"
    return None


SYSTEM = """너는 서울 옷가게 데이터를 정리하는 도우미다. 가게 이름, 카카오 분류, 공공데이터 업종, 주소를 보고 가게 종류를 하나 고른다.

- select_shop: 편집숍. 여러 브랜드를 골라 파는 감각적인 매장, 디자이너 쇼룸
- vintage: 빈티지·구제·세컨핸드 의류
- brand: 한 브랜드만 파는 매장 (나이키, 뉴발란스, 폴로, 닥스, 레노마, 크로커다일, 브랜드 직영점·대리점, 수입 명품 부티크)
- spa: SPA 체인 (유니클로, 탑텐, 자라 등)
- general: 동네 옷가게, 보세, 할인 의류점, 신발·가방 잡화점처럼 브랜드가 뚜렷하지 않은 일반 매장
- excluded: 손님이 걸어 들어가 옷을 둘러보고 사는 가게가 아님 (도매, 맞춤 전용 양복·셔츠 제작소, 한복, 단체복, 사무실·회사·온라인몰 본사, 수선, 대여, 의류 외 업종)
  속옷·란제리·양말·내의 매장은 브랜드 매장이어도 excluded (좋은사람들, 예스, 비비안, 원더브라, 와코루, 에탐, 인따르시아 등)
  공공데이터 업종이 중고 상품 소매업인데 이름에 옷 단서가 없으면 excluded (중고 가구·가전·고물)
  이름이 유명 브랜드와 같아도 동네 가게일 수 있다 (예: 양천구 '망고'는 SPA가 아님). 지점명이나 법인명 단서가 없으면 general

이름만으로 애매하면 general을 고른다. 브랜드를 알면 brand. reason은 한국어로 짧게."""


class Judgement(BaseModel):
    shop_id: int
    category: Category
    reason: str = Field(description="판단 근거, 짧게")


class Judgements(BaseModel):
    shops: list[Judgement]


def load_facts(conn, where: str, limit: int | None) -> list[Fact]:
    rows = conn.execute(
        f"""SELECT s.id, s.name,
                   (array_agg(r.category_name) FILTER (WHERE r.source = 'kakao'))[1],
                   (array_agg(r.category_name) FILTER (WHERE r.source = 'sbiz'))[1],
                   coalesce(s.road_address, s.address), s.in_market, b.kind
            FROM shops s
            JOIN raw_sources r ON r.shop_id = s.id
            LEFT JOIN buildings b ON b.building_id = s.building_id
            WHERE s.kind = 'store' AND {where}
            GROUP BY s.id, b.kind ORDER BY s.id {'LIMIT %s' % int(limit) if limit else ''}"""
    ).fetchall()
    return [Fact(shop_id=r[0], name=r[1], kakao_category=r[2], public_category=r[3], address=r[4], in_market=r[5], building_kind=r[6]) for r in rows]


def save(conn, shop_id: int, category: str, source: str, reason: str) -> None:
    conn.execute(
        """UPDATE shops SET category = %s, category_source = %s, category_reason = %s,
               status = CASE WHEN %s = 'excluded' THEN 'excluded' ELSE 'candidate' END, updated_at = now()
           WHERE id = %s""",
        (category, source, reason, category, shop_id),
    )


def run(rules_only: bool, limit: int | None, batch: int) -> dict:
    with connect() as conn, pipeline_run(conn, "classify_shops") as stats:
        # Rules are high precision, so they also override earlier AI answers. A rule result whose rule no longer
        # matches (the rules changed) goes back to AI.
        # 'evidence': corrected from the shop's own posts by pipeline.recheck_category — a name rule must not undo it.
        facts = load_facts(conn, "s.category_source IS DISTINCT FROM 'manual' AND s.category_source IS DISTINCT FROM 'evidence'", None)
        source = dict(conn.execute("SELECT id, category_source FROM shops WHERE kind = 'store'").fetchall())
        by_rule: dict[str, int] = {}
        stats["rule_reset"] = 0
        for f in facts:
            hit = rule_category(f)
            if hit:
                save(conn, f.shop_id, hit[0], "rule", hit[1])
                by_rule[hit[0]] = by_rule.get(hit[0], 0) + 1
            elif source.get(f.shop_id) == "rule":
                conn.execute("UPDATE shops SET category = NULL, category_source = NULL, category_reason = NULL WHERE id = %s", (f.shop_id,))
                stats["rule_reset"] += 1
        conn.commit()
        stats["rule"] = by_rule

        todo = load_facts(conn, "s.category IS NULL", limit)
        stats["ai_todo"] = len(todo)
        stats["ai_done"] = 0
        if not rules_only:
            for i in range(0, len(todo), batch):
                chunk = todo[i : i + batch]
                result = generate(
                    purpose="classify_shops",
                    system=SYSTEM,
                    prompt="각 가게의 종류를 골라라.\n\n" + json.dumps([f.model_dump() for f in chunk], ensure_ascii=False),
                    schema=Judgements,
                    tier="fast",
                    conn=conn,
                    run_id=stats["run_id"],
                )
                asked = {f.shop_id for f in chunk}
                for j in result.shops:
                    if j.shop_id in asked:
                        save(conn, j.shop_id, j.category, "ai", j.reason)
                        stats["ai_done"] += 1
                conn.commit()
                print(f"  {min(i + batch, len(todo))}/{len(todo)}", flush=True)
        stats["categories"] = dict(
            conn.execute("SELECT coalesce(category, 'unclassified'), count(*) FROM shops WHERE kind = 'store' GROUP BY 1").fetchall()
        )
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--rules-only", action="store_true")
    p.add_argument("--limit", type=int)
    p.add_argument("--batch", type=int, default=60)
    a = p.parse_args()
    print(json.dumps(run(a.rules_only, a.limit, a.batch), ensure_ascii=False, indent=2))
