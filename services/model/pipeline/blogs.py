"""Pipeline step ④: collect evidence per shop from Kakao (Daum) search: blogs first, then web pages, cafe posts and
videos (YouTube titles) for shops the blogs miss. Titles and snippets only, no page crawling.

Daum blog search also covers Naver blogs, and uses the KAKAO_REST_API_KEY we already have. (The Naver search API
stopped taking new applications on 2026-07-31.)

For each shop we search "<name> <동네>" and keep posts whose title or snippet contains the shop name. The search total,
matched post count and latest post date are stored on the shop: few or old mentions hint that a shop is closed.

Usage: python -m pipeline.blogs [--region 성수] [--limit 100] [--refresh-days 30]
"""

import argparse
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from app.settings import settings
from pipeline.db import connect, pipeline_run

URL_BASE = "https://dapi.kakao.com/v2/search"
REQUEST_GAP_S = 0.12

TAG = re.compile(r"<[^>]+>")
BRANCH = re.compile(r"\s+\S+점$")


def norm(text: str) -> str:
    return re.sub(r"[\s()\[\]·.,'\"&-]", "", text).lower()


# Company names that the public data puts in front of the shop name ("삼성물산비이커성수" → "비이커").
CORP_PREFIX = re.compile(
    r"^(삼성물산|에스제이그룹|신세계인터내셔날|인동에프엔|티에스리테일|브랜디드라이프스타일|엘엑스컴퍼니|스타럭스|위비스|"
    r"코오롱인더스트리|한섬|LF|엘에프|이랜드리테일|에프알엘|세정|패션그룹형지|형지|이터널그룹|무신사이구|29CM|"
    r"주식회사|\(주\)|㈜|더휴컴퍼니|지엔코|아이디룩|한세엠케이|비케이브랜즈|코웰패션|대현|신원)\s*"
)
# Words that say what a shop is rather than which shop it is.
GENERIC = re.compile(r"빈티지|vintage|구제|편집샵|편집숍|샵|숍|shop|스토어|store|옷가게|의류|패션|쇼룸|아울렛|매장|직영점|본점")


def shop_key(name: str, area: str | None = None) -> str:
    """The part of a shop name that a blogger would write: no company prefix, branch word, brackets or trailing area."""
    base = BRANCH.sub("", name)
    base = CORP_PREFIX.sub("", re.sub(r"\(.*?\)|\[.*?\]", "", base)).strip() or base
    key = norm(base)
    if area:
        place = norm(area.removesuffix("동"))
        if key.endswith(place) and len(key) - len(place) >= 3:
            key = key[: -len(place)]
    return key


def is_generic(key: str, area: str | None) -> bool:
    """'성수빈티지' is just '성수' + '빈티지': any post about vintage shops in 성수 would match it."""
    rest = GENERIC.sub("", key)
    if area:
        rest = rest.replace(norm(area.removesuffix("동")), "")
    return len(rest) < 2


def neighborhood(address: str | None) -> str | None:
    """'서울 성동구 성수동2가 280' → '성수동', '서울특별시 마포구 서교동 1' → '서교동'."""
    if not address:
        return None
    for token in address.split()[2:4]:
        if token.endswith(("동", "가")) and not token[0].isdigit():
            return re.sub(r"\d+가$|\d+동$", "동", token).replace("동동", "동")
    return None


def mentions(post: dict, key: str, area: str | None, raw_name: str = "") -> bool:
    title = TAG.sub("", html.unescape(post["title"]))
    body = TAG.sub("", html.unescape(post["contents"]))
    if len(key) < 2 or key not in norm(title + " " + body):
        return False
    if is_generic(key, area):
        # Only the exact written name counts, not the same words with a space between them.
        written = re.sub(r"\s+", "", BRANCH.sub("", raw_name)).lower()
        return bool(written) and written in (title + " " + body).lower()
    if len(key) <= 2:
        # Two letters are a common word ("한섬"): the title must name both the shop and the area.
        return area is not None and key in norm(title) and norm(area.removesuffix("동")) in norm(title)
    if len(key) == 3:
        return area is not None and norm(area.removesuffix("동")) in norm(title + body)
    return True


class KakaoSearch:
    """Daum search: blog, web, cafe and vclip (video; covers YouTube) share one endpoint shape and our REST key."""

    def __init__(self):
        if not settings.kakao_rest_api_key:
            raise RuntimeError("KAKAO_REST_API_KEY is not set (.env)")
        self.requests = 0

    def search(self, target: str, query: str) -> dict:
        size = {"blog": 30, "web": 30, "cafe": 30, "vclip": 20}[target]
        q = urllib.parse.urlencode({"query": query, "size": size, "sort": "accuracy"})
        req = urllib.request.Request(f"{URL_BASE}/{target}?{q}", headers={"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"})
        for attempt in range(5):
            time.sleep(REQUEST_GAP_S)
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    return json.load(res)
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    time.sleep(3 * (attempt + 1))
                    continue
                raise RuntimeError(f"Kakao search {e.code}: {e.read().decode(errors='replace')}") from e
            except urllib.error.URLError:
                time.sleep(3 * (attempt + 1))
        raise RuntimeError("Kakao search: repeated failures")


# Business-directory and real-estate pages that just repeat the public data; not evidence.
DIRECTORY_PAGE = re.compile(r"상가\s*목록|소매업|업종\s*·|실거래가|시세|사업자\s*정보|통신판매업|지도\s*·")

# (kakao search target, shop_facts.kind, shop_facts.source)
FALLBACKS = [("web", "web_page", "daum_web"), ("cafe", "cafe_post", "daum_cafe"), ("vclip", "video", "daum_vclip")]


def places_in(text: str, area: str | None, gu: str | None) -> bool:
    t = norm(text)
    return any(p and norm(p) in t for p in ((area or "").removesuffix("동"), gu, "서울"))


# An address match only counts when the post's title is about a clothes shop, not the café in the same building.
FASHION_TITLE = re.compile(r"빈티지|구제|편집샵|편집숍|셀렉트|쇼룸|옷가게|옷집|의류|패션|브랜드\s*매장|플래그십|vintage|select\s*shop", re.IGNORECASE)
FOOD_TITLE = re.compile(r"맛집|카페|커피|빙수|베이커리|빵|디저트|술집|식당|브런치|메뉴|와인|펍|오마카세")


def name_variants(raw: str) -> list[str]:
    """Other ways bloggers write the same name: '빈티지에어' → '에어빈티지', '에어 빈티지', '빈티지 에어'."""
    compact = re.sub(r"\s+", "", raw)
    out: list[str] = []
    for m in GENERIC.finditer(compact):
        word, rest = m.group(0), compact[: m.start()] + compact[m.end() :]
        if len(rest) < 2:
            continue
        for v in (rest + word, f"{rest} {word}", f"{word} {rest}", word + rest):
            if re.sub(r"\s+", "", v) != compact or " " in v:
                out.append(v)
    return list(dict.fromkeys(v for v in out if v != raw))[:4]


def road_spot(road_address: str | None) -> str | None:
    """'서울 성동구 연무장길 39' → '연무장길 39' (street + building number), the part bloggers copy into posts."""
    if not road_address:
        return None
    tokens = road_address.split()
    for i, t in enumerate(tokens[:-1]):
        if re.search(r"(로|길)$", t) and re.match(r"^\d+(-\d+)?$", tokens[i + 1]):
            return f"{t} {tokens[i + 1]}"
    return None


def collect(
    search: KakaoSearch, names: list[str], area: str | None, gu: str | None, road: str | None = None
) -> tuple[int, list[tuple[str, str, dict]]]:
    """Evidence for one shop, widening the search until something mentions it:
    1. blog "<name> <동네>" for each known name (Kakao's, the public data's, AI aliases)
    2. blog "<name>" alone, keeping posts that also mention the 동네, 구 or 서울
    3. blog with the name's words reordered ("빈티지에어" → "에어빈티지")
    4. blog "<도로명 번지>": posts that give this shop's street address and talk about clothes, whatever they call it
    5. web pages, cafe posts and videos (YouTube titles via Daum vclip) for "<name> <동네 or 구>"
    """
    found: dict[str, tuple[str, str, dict]] = {}
    total = 0
    place = (area or "").removesuffix("동") or gu or ""

    def take(docs, kind, source, key, raw, need_place=False):
        for d in docs:
            d = {**d, "contents": d.get("contents", "")}
            if kind != "blog_post" and DIRECTORY_PAGE.search(TAG.sub("", d["title"])):
                continue
            if mentions(d, key, area, raw) and (not need_place or places_in(d["title"] + " " + d["contents"], area, gu)):
                found.setdefault(d["url"], (kind, source, d))

    for raw in names:
        res = search.search("blog", f"{raw} {place}".strip())
        total = max(total, res.get("meta", {}).get("total_count", 0))
        take(res.get("documents", []), "blog_post", "daum_blog", shop_key(raw, area), raw)
    if len(found) < 2:
        for raw in names:
            if len(shop_key(raw, area)) >= 4:  # a bare short name finds unrelated shops everywhere
                take(search.search("blog", raw).get("documents", []), "blog_post", "daum_blog", shop_key(raw, area), raw, need_place=True)
    if not found:
        for v in name_variants(names[0]):
            take(search.search("blog", f"{v} {place}".strip()).get("documents", []), "blog_post", "daum_blog", shop_key(v, area), v)
            if found:
                break
    if not found and road:
        spot = norm(road)
        for d in search.search("blog", road).get("documents", []):
            title = TAG.sub("", html.unescape(d["title"]))
            text = title + " " + TAG.sub("", html.unescape(d.get("contents", "")))
            if spot in norm(text) and FASHION_TITLE.search(title) and not FOOD_TITLE.search(title):
                found.setdefault(d["url"], ("address_post", "daum_blog", {**d, "contents": d.get("contents", "")}))
    if not found:
        raw = names[0]
        for target, kind, source in FALLBACKS:
            take(search.search(target, f"{raw} {place}".strip()).get("documents", []), kind, source, shop_key(raw, area), raw)
    return total, list(found.values())


def post_date(d: dict) -> date | None:
    """Kakao sends 1970-01-01 when it doesn't know a post's date; anything before 2000 is treated as unknown."""
    if not d.get("datetime"):
        return None
    posted = date.fromisoformat(d["datetime"][:10])
    return posted if posted.year >= 2000 else None


def query_names(kakao_names: list[str], public_name: str, aliases: list[str] | None = None) -> list[str]:
    out: list[str] = []
    for n in [*kakao_names, public_name, *(aliases or [])]:
        clean = CORP_PREFIX.sub("", BRANCH.sub("", n)).strip() or n
        if clean and clean not in out:
            out.append(clean)
    return out[:3]


def select_shops(conn, region: str | None, limit: int | None, refresh_days: int, retry_empty: bool, categories: list[str] | None = None) -> list[tuple]:
    stale = "s.evidence_at IS NULL OR s.evidence_at < now() - make_interval(days => %s)"
    if retry_empty:
        stale += " OR (coalesce(s.matched_posts, 0) = 0 AND s.evidence_at < now() - interval '1 hour')"
    sql = f"""SELECT s.id, s.name,
                     coalesce((SELECT array_agg(r.name) FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao'), '{{}}'),
                     coalesce(s.address, s.road_address), s.road_address, coalesce(s.aliases, '{{}}')
              FROM shops s
              WHERE s.kind = 'store' AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
                AND ({stale})"""
    params: list = [refresh_days]
    if region:
        sql += " AND EXISTS (SELECT 1 FROM regions g WHERE g.name = %s AND ST_Intersects(g.polygon, s.geom))"
        params.append(region)
    if categories:
        sql += " AND s.category = ANY(%s)"
        params.append(categories)
    # Distinctive shops first: they matter most for style courses.
    sql += " ORDER BY (s.category IN ('select_shop', 'vintage', 'brand')) DESC, s.id"
    if limit:
        sql += " LIMIT %s"
        params.append(limit)
    return conn.execute(sql, params).fetchall()


def run(region: str | None, limit: int | None, refresh_days: int, retry_empty: bool = False, categories: list[str] | None = None) -> dict:
    search = KakaoSearch()
    with connect() as conn, pipeline_run(conn, "blogs") as stats:
        shops = select_shops(conn, region, limit, refresh_days, retry_empty, categories)
        stats.update(region=region, shops=len(shops), with_evidence=0, facts=0, by_source={})
        for i, (shop_id, public_name, kakao_names, address, road_address, aliases) in enumerate(shops, 1):
            area = neighborhood(address)
            gu = address.split()[1] if address and len(address.split()) > 1 else None
            total, facts = collect(search, query_names(kakao_names, public_name, aliases), area, gu, road_spot(road_address))
            conn.execute("DELETE FROM shop_facts WHERE shop_id = %s", (shop_id,))
            for kind, source, d in facts:
                posted = post_date(d)
                conn.execute(
                    """INSERT INTO shop_facts (shop_id, kind, title, snippet, url, posted_on, source)
                       VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                    (shop_id, kind, TAG.sub("", html.unescape(d["title"])), TAG.sub("", html.unescape(d["contents"])) or None,
                     d["url"], posted, source),
                )
                stats["by_source"][source] = stats["by_source"].get(source, 0) + 1
            # New evidence means the scores and confidence must be redone.
            conn.execute(
                """UPDATE shops SET mention_count = %s, matched_posts = %s, evidence_at = now(),
                       last_mention_on = (SELECT max(posted_on) FROM shop_facts WHERE shop_id = %s),
                       scored_at = NULL, confidence = NULL
                   WHERE id = %s""",
                (total, len(facts), shop_id, shop_id),
            )
            stats["with_evidence"] += bool(facts)
            stats["facts"] += len(facts)
            if i % 50 == 0:
                conn.commit()
                print(f"  {i}/{len(shops)}", flush=True)
        conn.commit()
        stats["requests"] = search.requests
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    p.add_argument("--refresh-days", type=int, default=30)
    p.add_argument("--retry-empty", action="store_true", help="search again for shops that had no evidence")
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit, a.refresh_days, a.retry_empty), ensure_ascii=False, indent=2, default=str))
