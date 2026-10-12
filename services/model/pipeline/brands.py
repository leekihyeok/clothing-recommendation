"""Pipeline step: which brands each shop carries, for "브랜드로 찾기" ("아더에러 파는 데").

- Brand stores (category brand): the brand is the store's own Kakao name without the branch part ("글로니 한남플래그쉽
  스토어" → 글로니, "LMR 서울숲쇼룸" → LMR). Shops known only from public data carry company names ("현대백화점언더아머
  천호점"), so they're left out. No AI.
- Select shops and vintage shops with posts (step ④): AI reads the posts and lists the brands the posts say are sold
  *there* — not brands worn by the writer, sold next door, or named in passing — with the Korean and English spelling.

Brands go to a small dictionary (brands) under one key per brand; both spellings are kept as aliases, so a search
for either finds it, and a new spelling joins the brand that already has the other one.

Usage: python -m pipeline.brands [--region 성수] [--limit 100] [--batch 10] [--names-only]
"""

import argparse
import json
import re

from pydantic import BaseModel, Field

from ai import generate
from pipeline.db import connect, pipeline_run

BRANCH = re.compile(
    r"\s+(\S*(점|점포|쇼룸|플래그십스토어|플래그쉽스토어|플래그십|플래그쉽|스토어|매장|아울렛|팝업|showroom|store|flagship))$", re.I
)
GENERIC = {"편집숍", "편집샵", "빈티지", "구제", "옷가게", "의류", "쇼룸", "스토어", "브랜드", "셀렉트샵", "아울렛", "매장", "기타", "각종"}


def norm(text: str) -> str:
    """The search key: lower case, letters and Hangul only ("ADER ERROR" → "adererror", "아더 에러" → "아더에러")."""
    return re.sub(r"[^0-9a-z가-힣]", "", text.lower())


ARTICLES = {"더", "디", "르", "라", "the", "le", "la"}
LATIN = re.compile(r"[A-Za-z0-9&.\-']+")


def place_words(conn) -> set[str]:
    """Seoul neighbourhood and station names, to cut off a branch glued to a brand ("닥스신사" → 닥스)."""
    words: set[str] = set()
    for (stations,) in conn.execute("SELECT stations FROM regions").fetchall():
        words.update(st.replace("역", "").split("(")[0] for st in stations or [])
    for (dong,) in conn.execute("SELECT DISTINCT split_part(address, ' ', 3) FROM raw_sources WHERE address LIKE '서울%%'").fetchall():
        m = re.match(r"^([가-힣]+?)\d*(?:가)?동$", dong or "")
        if m:
            words.add(m.group(1))
    return {w for w in words if len(w) >= 2}


def brand_of_store(name: str, places: set[str] = frozenset()) -> str | None:
    """A brand store's brand from its Kakao name: the brand comes first, the branch after it in many forms ("아더에러
    성수스페이스", "칼하트WIP 홍대와우산", "살로몬 트레일 런 서울"), so the first word is the brand — two when the
    first is an article ("더 노스페이스"), and a run of Latin words together ("Stone Island 청담")."""
    n = name.strip()
    while True:
        m = BRANCH.search(n)
        if not m:
            break
        n = n[: m.start()].strip()
    words = n.split()
    if not words:
        return None
    if LATIN.fullmatch(words[0]):
        run = [w for w in words[: next((i for i, w in enumerate(words) if not LATIN.fullmatch(w)), len(words))]]
        brand = " ".join(run)
    elif words[0].lower() in ARTICLES and len(words) > 1:
        brand = " ".join(words[:2])
    else:
        brand = words[0]
    # A neighbourhood glued to the end of a Korean brand ("마에스트로신사"): the brand is the part before it.
    if re.fullmatch(r"[가-힣]+", brand):
        cut = next((w for w in sorted(places, key=len, reverse=True) if brand.endswith(w) and len(brand) - len(w) >= 2), None)
        if cut:
            brand = brand[: -len(cut)]
    key = norm(brand)
    return brand if len(key) >= 2 and key not in GENERIC else None


SYSTEM = """너는 옷가게가 어떤 브랜드를 파는지 정리하는 에디터다. 가게마다 이름과 블로그·카페 글 몇 개(제목, 요약)를 준다.

- brands: 글에 **이 가게에서 판다/들어와 있다/입고됐다**고 나온 옷·신발·가방·액세서리 브랜드만 (최대 12개).
  글쓴이가 입고 간 옷, 다른 가게 이야기, 비교로만 나온 브랜드, 스타일 말('아메카지', '밀리터리')은 넣지 않는다.
  빈티지·구제 숍은 '리바이스, 칼하트 빈티지가 많다'처럼 많이 보인다고 한 브랜드를 넣는다.
- name: 글에 쓰인 대로의 한국어 표기(없으면 영문 그대로), en: 영문 표기(알면). 예: {"name": "아더에러", "en": "ADER ERROR"}.
- 근거가 없으면 brands는 빈 목록."""


class Brand(BaseModel):
    name: str
    en: str = ""


class ShopBrands(BaseModel):
    shop_id: int
    brands: list[Brand] = Field(default_factory=list, max_length=12)


class Batch(BaseModel):
    shops: list[ShopBrands]


def upsert_brand(conn, name: str, en: str = "") -> str | None:
    """The brand's key, adding it (or a new spelling of it) to the dictionary."""
    name, en = name.strip()[:40], en.strip()[:40]
    keys = [k for k in {norm(name), norm(en)} if len(k) >= 2 and k not in GENERIC]
    if not keys:
        return None
    hit = conn.execute("SELECT key, aliases, name_en FROM brands WHERE aliases && %s LIMIT 1", (keys,)).fetchone()
    if hit:
        key, aliases, name_en = hit
        new = sorted(set(aliases) | set(keys))
        if new != sorted(aliases) or (en and not name_en):
            conn.execute("UPDATE brands SET aliases = %s, name_en = coalesce(name_en, %s) WHERE key = %s", (new, en or None, key))
        return key
    key = norm(en) if len(norm(en)) >= 2 else keys[0]
    # Show the Korean spelling when there is one ("아더에러"), else as written ("LMR").
    shown = name if re.search(r"[가-힣]", name) or not en else en
    conn.execute(
        "INSERT INTO brands (key, name, name_en, aliases) VALUES (%s, %s, %s, %s) ON CONFLICT (key) DO NOTHING",
        (key, shown, en or (name if re.fullmatch(r"[A-Za-z0-9 &.\-']+", name) else None), keys),
    )
    return key


def store_names(conn, stats: dict) -> None:
    """Brand stores: their own brand, from the Kakao name (and the shop's other spellings as aliases)."""
    rows = conn.execute(
        """SELECT s.id, (SELECT r.name FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' ORDER BY r.id LIMIT 1), s.aliases
           FROM shops s WHERE s.status = 'candidate' AND s.category = 'brand'
             AND NOT EXISTS (SELECT 1 FROM shop_brands b WHERE b.shop_id = s.id AND b.source = 'name')"""
    ).fetchall()
    places = place_words(conn)
    for shop_id, kakao_name, aliases in rows:
        brand = brand_of_store(kakao_name, places) if kakao_name else None
        if not brand:
            continue
        latin = next((a for a in aliases or [] if re.fullmatch(r"[A-Za-z0-9 &.\-']+", a)), "")
        key = upsert_brand(conn, brand, latin if not re.fullmatch(r"[A-Za-z0-9 &.\-']+", brand) else brand)
        if key:
            conn.execute("INSERT INTO shop_brands (shop_id, brand_key, source) VALUES (%s, %s, 'name') ON CONFLICT DO NOTHING", (shop_id, key))
            stats["from_names"] += 1
    conn.commit()


def run(region: str | None, limit: int | None, batch: int, categories: list[str] | None = None, names_only: bool = False) -> dict:
    with connect() as conn, pipeline_run(conn, "brands") as stats:
        stats.update(region=region, from_names=0, shops=0, with_brands=0)
        if not categories or "brand" in categories:
            store_names(conn, stats)
        if names_only:
            return stats
        kinds = [c for c in (categories or ["select_shop", "vintage"]) if c in ("select_shop", "vintage")]
        if not kinds:
            return stats
        sql = """SELECT s.id, s.name FROM shops s
                 WHERE s.status = 'candidate' AND s.category = ANY(%s) AND coalesce(s.matched_posts, 0) > 0
                   AND s.evidence_at IS NOT NULL AND (s.brands_at IS NULL OR s.brands_at < s.evidence_at)"""
        params: list = [kinds]
        if region:
            sql += " AND EXISTS (SELECT 1 FROM regions g WHERE g.name = %s AND ST_Intersects(g.polygon, s.geom))"
            params.append(region)
        sql += " ORDER BY s.id"
        if limit:
            sql += " LIMIT %s"
            params.append(limit)
        shops = conn.execute(sql, params).fetchall()
        stats["shops"] = len(shops)
        for i in range(0, len(shops), batch):
            chunk = []
            for shop_id, name in shops[i : i + batch]:
                posts = conn.execute(
                    """SELECT title, left(snippet, 300) FROM shop_facts WHERE shop_id = %s
                       ORDER BY (kind = 'blog_post') DESC, posted_on DESC NULLS LAST LIMIT 6""",
                    (shop_id,),
                ).fetchall()
                chunk.append({"shop_id": shop_id, "name": name, "posts": [{"title": t, "snippet": s} for t, s in posts]})
            result = generate(
                purpose="shop_brands", system=SYSTEM,
                prompt="각 가게에서 파는 브랜드를 정리해라.\n\n" + json.dumps(chunk, ensure_ascii=False),
                schema=Batch, tier="fast", conn=conn, run_id=stats["run_id"],
            )
            asked = {c["shop_id"] for c in chunk}
            for r in result.shops:
                if r.shop_id not in asked:
                    continue
                conn.execute("DELETE FROM shop_brands WHERE shop_id = %s AND source = 'blog'", (r.shop_id,))
                keys = {k for b in r.brands if (k := upsert_brand(conn, b.name, b.en))}
                for k in keys:
                    conn.execute("INSERT INTO shop_brands (shop_id, brand_key, source) VALUES (%s, %s, 'blog') ON CONFLICT DO NOTHING", (r.shop_id, k))
                stats["with_brands"] += bool(keys)
            conn.execute("UPDATE shops SET brands_at = now() WHERE id = ANY(%s)", (list(asked),))
            conn.commit()
            print(f"  {min(i + batch, len(shops))}/{len(shops)} (with brands {stats['with_brands']})", flush=True)
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    p.add_argument("--batch", type=int, default=10)
    p.add_argument("--names-only", action="store_true")
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit, a.batch, names_only=a.names_only), ensure_ascii=False, indent=2))
