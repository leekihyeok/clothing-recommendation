"""Pipeline step: opening hours from the blog posts collected in step ④.

Owner-entered hours (shop_owner_info) are rare, so a course can't tell which shops are open. Many posts carry a line like
"영업시간 : 매일 11:00 – 21:00 (월요일 휴무)". Shops whose posts have such a line go to AI in batches; it reads the week
in the owner format (Mon..Sun, {"closed", "open", "close"}) from each post whose hours clearly belong to this shop — a
post often lists a restaurant or café next door, or a pop-up's event hours — and names the shop the hours were under,
which has to match this shop's own names (two shops at one address fooled it otherwise). Shops without a hint in their posts cost nothing.

The newest post with a usable week wins (hours change; picked here, not by the AI); the API ignores hours from posts older than three years and always prefers the
owner's. Re-runs only shops whose evidence changed since they were last read.

Usage: python -m pipeline.hours [--region 성수] [--limit 100] [--batch 12]
"""

import argparse
import json
import re

from typing import Literal

from pydantic import BaseModel, Field

from ai import generate
from pipeline.db import connect, pipeline_run
from pipeline.merge_dupes import core, same_name

# A post worth reading for hours: says 영업/운영 시간 or 휴무, or has a time range like "11:00~21:00".
HINT_SQL = r"(영업|운영)\s*(시간|일)|휴무|[0-2]?[0-9]\s*:\s*[0-5][0-9]\s*[~∼\-–—]"
POSTS_PER_SHOP = 4

SYSTEM = """너는 옷가게 영업시간을 정리하는 에디터다. 가게마다 이름, 주소와 블로그 글 몇 개(번호, 날짜, 제목, 요약)를 준다.

- readings: 글마다 **이 가게의** 영업시간이 적혀 있으면 하나씩 (post에 글 번호). 없는 글은 넣지 않는다.
  같은 글에 나온 다른 가게(식당, 카페, 다른 옷가게)의 시간, 팝업·전시·행사 기간의 시간은 넣지 않는다.
  가게 이름(또는 지점명) 바로 근처에 있는 시간이 그 가게 것이다. 주소가 같거나 비슷해도 시간 앞에 적힌 가게 이름이
  다르면 다른 가게다 (같은 건물에 여러 가게가 있다). 애매하면 넣지 않는다.
- named_as: 그 영업시간 바로 앞에 글이 적은 가게 이름을 글에 쓰인 그대로 (예: "Fabrique(파브리크)스토어").
- rules: 글에 적힌 대로 요일 묶음별 시간. days는 "매일", "평일", "주말", "월"~"일" 중에서 (예: 월~토 → ["월","화","수","목","금","토"]).
  요일 말 없이 시간만 있으면 ["매일"]. open/close는 "HH:MM" 24시간제 ("오후 8시" → "20:00", "저녁 7시 30분" → "19:30").
  자정은 "24:00", 새벽까지면 "02:00"처럼 그대로 (다음 날로 넘어가는 것으로 본다). "24시간" → "00:00"~"24:00".
- closed: 글에 쉰다고 적힌 요일만 ("매주 일요일 정기휴무" → ["일"], "연중무휴" → []). 적히지 않은 요일을 짐작하지 않는다.
- note: "매월 마지막 월요일 휴무", "브레이크타임 15:00~16:00", "라스트오더 20:30"처럼 7일 표에 못 넣는 말만 짧게. 없으면 빈 문자열.
- 글에 없는 시간을 짐작해서 채우지 않는다."""


DayWord = Literal["매일", "평일", "주말", "월", "화", "수", "목", "금", "토", "일"]
WEEK = ["월", "화", "수", "목", "금", "토", "일"]
GROUPS = {"매일": WEEK, "평일": WEEK[:5], "주말": WEEK[5:]}


class Rule(BaseModel):
    days: list[DayWord]
    open: str
    close: str


class Reading(BaseModel):
    post: int = Field(description="글 번호")
    named_as: str = Field(description="영업시간 앞에 글이 적은 가게 이름, 글 그대로")
    rules: list[Rule]
    closed: list[DayWord] = Field(default_factory=list)
    note: str = ""


class ShopHours(BaseModel):
    shop_id: int
    readings: list[Reading] = Field(default_factory=list)


class Batch(BaseModel):
    shops: list[ShopHours]


TIME = re.compile(r"^([01]\d|2[0-4]):([0-5]\d)$")


def named_this(named_as: str, names: list[str]) -> bool:
    """The name the post put the hours under is this shop's (or one of its aliases): "Fabrique(파브리크)스토어" for
    파브리크스토어, never "아틀리에 델디오" for 버블골드 next door."""
    branch = re.sub(r"\D", "", named_as)
    parts = [core(x) for x in re.split(r"[()\[\]/·|,]", named_as) + [named_as]]
    parts = [x for x in parts if len(x) >= 2]
    for name in names:
        own = core(name)
        # "홍대3호점" hours are not "홍대 4호점"'s.
        if len(own) < 2 or (branch and re.sub(r"\D", "", name) and branch != re.sub(r"\D", "", name)):
            continue
        if any(x in own or own in x for x in parts) or same_name(named_as, name):
            return True
    return False


BRANCH = re.compile(r"(\d+)\s*호점")


def same_branch(name: str, post: tuple) -> bool:
    """A post about "홍대3호점" isn't about "홍대 4호점", even when the AI wrote the name without the number."""
    own = BRANCH.findall(name)
    told = BRANCH.findall(f"{post[0] or ''} {post[1] or ''}")
    return not own or not told or own[0] in told


def week(r: Reading) -> list[dict] | None:
    """The post's rules as a Mon..Sun week in the owner format, or None when they don't make one.

    Expanded here rather than by the AI (a light model wrote "일요일 휴무" as Saturday and Sunday off). A named day wins
    over a group ("매일 11-21, 토 12-20"). A day no rule names and no "휴무" covers stays unknown ({"closed": false} without
    times, as openAt reads it): snippets are cut off mid-list ("월,수,토 12:30~17:50 화,목,금...")."""
    closed = {d for w in r.closed for d in GROUPS.get(w, [w])}
    hours: dict[str, tuple[str, str]] = {}
    for rule in sorted(r.rules, key=lambda x: max(len(GROUPS.get(w, [w])) for w in x.days) if x.days else 7, reverse=True):
        if not TIME.match(rule.open) or not TIME.match(rule.close) or rule.open == "24:00" or rule.open == rule.close:
            return None
        for w in rule.days or ["매일"]:
            for d in GROUPS.get(w, [w]):
                hours[d] = (rule.open, rule.close)
    if not hours:
        return None
    out = [
        {"closed": True} if d in closed else {"closed": False, "open": hours[d][0], "close": hours[d][1]} if d in hours else {"closed": False}
        for d in WEEK
    ]
    return out if any("open" in d for d in out) else None


def run(region: str | None, limit: int | None, batch: int, categories: list[str] | None = None) -> dict:
    with connect() as conn, pipeline_run(conn, "hours") as stats:
        sql = """SELECT s.id, s.name, s.road_address, coalesce(s.aliases, '{}') ||
                        coalesce((SELECT array_agg(DISTINCT r.name) FROM raw_sources r WHERE r.shop_id = s.id), '{}')
                 FROM shops s
                 WHERE s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
                   AND s.evidence_at IS NOT NULL AND (s.hours_at IS NULL OR s.hours_at < s.evidence_at)
                   AND EXISTS (SELECT 1 FROM shop_facts f WHERE f.shop_id = s.id AND f.snippet ~ %s)"""
        params: list = [HINT_SQL]
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
        stats.update(region=region, shops=len(shops), found=0)
        for i in range(0, len(shops), batch):
            chunk, posts_of, names_of = [], {}, {}
            for shop_id, name, address, other_names in shops[i : i + batch]:
                names_of[shop_id] = [name, *other_names]
                posts = conn.execute(
                    """SELECT title, snippet, url, posted_on FROM shop_facts WHERE shop_id = %s AND snippet ~ %s
                       ORDER BY posted_on DESC NULLS LAST LIMIT %s""",
                    (shop_id, HINT_SQL, POSTS_PER_SHOP),
                ).fetchall()
                posts_of[shop_id] = posts
                chunk.append({
                    "shop_id": shop_id, "name": name, "address": address,
                    "posts": [
                        {"post": k + 1, "date": str(d) if d else None, "title": t, "snippet": (s or "")[:400]}
                        for k, (t, s, _, d) in enumerate(posts)
                    ],
                })
            result = generate(
                purpose="shop_hours", system=SYSTEM,
                prompt="각 가게의 영업시간을 정리해라.\n\n" + json.dumps(chunk, ensure_ascii=False),
                schema=Batch, tier="fast", conn=conn, run_id=stats["run_id"],
            )
            answered = {h.shop_id: h for h in result.shops if h.shop_id in posts_of}
            for shop_id, posts in posts_of.items():
                # The newest post with a usable week for this shop's own name (posts are numbered newest first).
                best = None
                for r in sorted(answered[shop_id].readings if shop_id in answered else [], key=lambda r: r.post):
                    ok = 1 <= r.post <= len(posts) and named_this(r.named_as, names_of[shop_id]) and same_branch(names_of[shop_id][0], posts[r.post - 1])
                    w = week(r) if ok else None
                    if w:
                        best = (r, w)
                        break
                if best is None:
                    # Looked and found nothing usable: don't ask again until the evidence changes (older hours stay).
                    conn.execute("UPDATE shops SET hours_at = now() WHERE id = %s", (shop_id,))
                    continue
                r, w = best
                post = posts[r.post - 1]
                conn.execute(
                    """UPDATE shops SET hours = %s, hours_note = %s, hours_url = %s, hours_posted_on = %s, hours_at = now()
                       WHERE id = %s""",
                    (json.dumps(w), r.note.strip()[:100] or None, post[2], post[3], shop_id),
                )
                stats["found"] += 1
            conn.commit()
            print(f"  {min(i + batch, len(shops))}/{len(shops)} (found {stats['found']})", flush=True)
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    p.add_argument("--batch", type=int, default=12)
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit, a.batch), ensure_ascii=False, indent=2))
