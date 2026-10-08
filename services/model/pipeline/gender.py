"""Pipeline step: whose clothes a shop sells — men | women | unisex | kids, NULL when nothing says.

Evidence, strongest first:
  - Kakao's own category: "… > 의류판매 > 여성의류" / "남성의류,양복" / "아동복,유아복"           (2 points)
  - words in the name or the summary the posts gave: 맨즈·옴므·남성복 / 우먼·여성복 / 남녀공용·유니섹스 (2 points)
  - the public-data business type "여성 의류 소매업" / "남성 의류 소매업" — registered once, often loosely (1 point)
Both men and women with 2+ points each, or a 남녀공용-type word, make it unisex; otherwise the side with more points
wins (the public type alone is enough: it agrees with Kakao's category for about 93% of shops that have both). Department stores and malls (kind 'complex') sell to everyone: unisex.
Shops none of this speaks for keep what the AI scoring read in the posts (pipeline.score), or take their brand's
answer when its other branches agree. Re-run any time (monthly with the data refresh); it only writes what changed.

Usage: python -m pipeline.gender [--dry-run]
"""

import argparse
import json
import re

from pipeline.db import connect, pipeline_run

MEN_WORDS = re.compile(r"맨즈|옴므|homme|\bmen\b|men's|남성복|남성\s*의류|남자\s*옷|남성\s*(전문|브랜드|편집)|수트|양복|맞춤\s*정장", re.I)
WOMEN_WORDS = re.compile(r"우먼|women|여성복|여성\s*의류|여자\s*옷|여성\s*(전문|브랜드|편집)|레이디|원피스\s*전문", re.I)
BOTH_WORDS = re.compile(r"남녀\s*(공용|모두|함께)|남녀공용|유니섹스|unisex|젠더리스|커플\s*룩", re.I)
KIDS_WORDS = re.compile(r"키즈|kids|아동복|유아복|베이비|주니어|칠드런", re.I)


def judge(kind: str, name: str, summary: str, kakao_cats: list[str], public_cats: list[str], category: str | None = None) -> str | None:
    if kind == "complex":
        return "unisex"
    men = women = 0
    kids = False
    both = bool(BOTH_WORDS.search(f"{name} {summary}"))
    for c in kakao_cats:
        if "여성의류" in c:
            women += 2
        if "남성의류" in c:
            men += 2
        if "아동복" in c:
            kids = True
    for c in public_cats:
        if c.startswith("여성 의류"):
            women += 1
        if c.startswith("남성 의류"):
            men += 1
    text = f"{name} {summary}"
    if MEN_WORDS.search(text):
        men += 2
    if WOMEN_WORDS.search(text):
        women += 2
    if kids or KIDS_WORDS.search(name):
        return "kids" if men < 2 and women < 2 else "unisex"
    if both or (men >= 2 and women >= 2):
        return "unisex"
    # Select and vintage shops mostly sell to everyone; the loose public type alone (1 point) doesn't decide for them.
    floor = 2 if category in MIXED_CATEGORIES else 1
    if men > women and men >= floor:
        return "men"
    if women > men and women >= floor:
        return "women"
    return None


# A branch name's area tail ("트리밍버드성수", "팔라스스케이트보드 홍대점"), dropped to get the brand.
AREA_TAIL = re.compile(
    r"(성수|홍대|한남|이태원|명동|강남|신촌|연남|망원|압구정|가로수길|청담|잠실|건대|합정|을지로|종로|동대문|서울숲|롯데월드몰|더현대)?\s*(\S*점)?$"
)
BRAND_AGREE = 0.8
MIXED_CATEGORIES = {"select_shop", "vintage"}


def brand(name: str) -> str:
    """"트리밍버드 롯데월드몰 잠실점" → "트리밍버드": the first word, area tail dropped, spaces and case ignored."""
    first = name.strip().split()[0] if name.strip() else ""
    return AREA_TAIL.sub("", first).lower()


def by_brand(judged: dict[int, tuple[str, str | None]]) -> dict[int, str]:
    """Shops nothing speaks for take their brand's answer, when its known branches (2+) agree at least 80%."""
    votes: dict[str, dict[str, int]] = {}
    for key, g in judged.values():
        if g and len(key) >= 2:
            votes.setdefault(key, {}).setdefault(g, 0)
            votes[key][g] += 1
    answer = {}
    for key, v in votes.items():
        total = sum(v.values())
        g, n = max(v.items(), key=lambda x: x[1])
        if total >= 2 and n / total >= BRAND_AGREE:
            answer[key] = g
    return {shop_id: answer[key] for shop_id, (key, g) in judged.items() if g is None and key in answer}


def run(dry_run: bool) -> dict:
    with connect() as conn, pipeline_run(conn, "gender") as stats:
        rows = conn.execute(
            """SELECT s.id, s.kind, s.name, coalesce(s.summary, ''), s.gender, s.gender_source, s.category,
                      coalesce(array_agg(r.category_name) FILTER (WHERE r.source = 'kakao' AND r.category_name IS NOT NULL), '{}'),
                      coalesce(array_agg(r.category_name) FILTER (WHERE r.source <> 'kakao' AND r.category_name IS NOT NULL), '{}'),
                      coalesce(array_agg(r.name) FILTER (WHERE r.source = 'kakao'), '{}')
               FROM shops s LEFT JOIN raw_sources r ON r.shop_id = s.id
               WHERE s.status = 'candidate'
               GROUP BY s.id"""
        ).fetchall()
        judged: dict[int, tuple[str, str | None]] = {}
        old_of = {}
        for shop_id, kind, name, summary, old, old_source, category, kakao_cats, public_cats, kakao_names in rows:
            judged[shop_id] = (brand(kakao_names[0] if kakao_names else name), judge(kind, " ".join([name, *kakao_names]), summary, kakao_cats, public_cats, category))
            old_of[shop_id] = (old, old_source)
        from_brand = by_brand(judged)
        # Rules first, then the brand's other branches, then what the AI scoring read in the posts (pipeline.score).
        final: dict[int, tuple[str | None, str | None]] = {}
        for i, (_, g) in judged.items():
            if g:
                final[i] = (g, "rule")
            elif i in from_brand:
                final[i] = (from_brand[i], "brand")
            elif old_of[i][1] == "ai":
                final[i] = old_of[i]  # the rules have nothing to say: what the AI read in the posts stays
            else:
                final[i] = (None, None)
        changes = [(i, g, src) for i, (g, src) in final.items() if (g, src) != old_of[i]]
        counts: dict[str, int] = {}
        for g, _ in final.values():
            counts[g or "unknown"] = counts.get(g or "unknown", 0) + 1
        stats.update(checked=len(rows), changed=len(changes), from_brand=len(from_brand), counts=counts)
        if dry_run:
            return stats
        for shop_id, new, src in changes:
            conn.execute("UPDATE shops SET gender = %s, gender_source = %s WHERE id = %s", (new, src, shop_id))
        conn.commit()
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    print(json.dumps(run(a.dry_run), ensure_ascii=False, indent=2))
