"""Pipeline step: re-check shops that "문 닫혀 있었어요" reports took out (status 'suspended', see ClosuresService in
apps/api/src/me/closures.service.ts).

For each one: is the place still on Kakao Map at that spot (same place id, or the same name within 200 m), and has
anyone written about it lately (evidence from step ④ within 180 days, or a fresh search done here when the stored
evidence is old — suspended shops drop out of step ④)?
  - on Kakao and mentioned lately → open: back to 'candidate'; the reports before this check stop counting
  - not on Kakao any more         → closed: status 'closed'. A shop known only from the public data (no Kakao place
                                    to look for, and its registered company name rarely matches Kakao) is closed only
                                    when people reported it; otherwise unsure
  - on Kakao but nothing recent   → unsure: stays out of courses, checked again after RECHECK_UNSURE_DAYS
Kakao Map keeps some closed places for a while, so "on Kakao" alone isn't enough to bring a reported shop back.

Two more ways a shop gets here, both from the scheduled refresh (pipeline.refresh):
  - stale_check (weekly): nothing written about it for over a year and gone from Kakao Map
  - vanished (monthly): its Kakao places didn't come back in this month's Kakao sweep
Both only suspend; the re-check above decides.

Usage: python -m pipeline.closures [--limit N] [--stale N]
"""

import argparse
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from datetime import date

from app.settings import settings
from pipeline.blogs import KakaoSearch, collect, neighborhood, post_date, query_names, road_spot
from pipeline.db import connect, pipeline_run

URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
RADIUS_M = 200
RECENT_DAYS = 180
RECHECK_UNSURE_DAYS = 14
STALE_AFTER_DAYS = 365
STALE_RECHECK_DAYS = 90
# A sweep that lost more than this share of linked places is suspect (cut short, Kakao hiccup): don't act on it.
VANISHED_MAX_SHARE = 0.05
REQUEST_GAP_S = 0.12


def norm(name: str) -> str:
    """Same idea as dedupe's NORM: drop a trailing branch word (…점), brackets and spaces."""
    name = re.sub(r"\s+\S+점$", "", name)
    name = re.sub(r"\(.*?\)|\[.*?\]", "", name)
    return re.sub(r"\s", "", name).lower()


def kakao_nearby(query: str, lon: float, lat: float) -> list[dict]:
    q = urllib.parse.urlencode({"query": query, "x": lon, "y": lat, "radius": RADIUS_M, "sort": "distance", "size": 15})
    req = urllib.request.Request(f"{URL}?{q}", headers={"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"})
    for attempt in range(4):
        time.sleep(REQUEST_GAP_S)
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.load(res)["documents"]
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"Kakao {e.code}: {e.read().decode(errors='replace')}") from e
        except urllib.error.URLError:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Kakao: repeated failures")


def still_on_kakao(names: list[str], place_ids: set[str], lon: float, lat: float) -> dict:
    wanted = {norm(n) for n in names if n}
    for name in dict.fromkeys(n for n in names if n):
        for d in kakao_nearby(name, lon, lat):
            if d["id"] in place_ids:
                return {"found": True, "how": "same place id", "place": d["place_name"]}
            if norm(d["place_name"]) in wanted:
                return {"found": True, "how": "same name nearby", "place": d["place_name"], "distance_m": int(d.get("distance") or 0)}
    return {"found": False}


def latest_post(search: KakaoSearch, name: str, kakao_names: list[str], aliases: list[str], address: str | None, road: str | None) -> date | None:
    """Newest post about the shop from a fresh step-④ style search (nothing is stored)."""
    gu = address.split()[1] if address and len(address.split()) > 1 else None
    _, facts = collect(search, query_names(kakao_names, name, aliases), neighborhood(address), gu, road_spot(road))
    return max(filter(None, (post_date(d) for _, _, d in facts)), default=None)


def run(limit: int | None) -> dict:
    if not settings.kakao_rest_api_key:
        raise RuntimeError("KAKAO_REST_API_KEY is not set (.env)")
    with connect() as conn, pipeline_run(conn, "closures") as stats:
        sql = """
            SELECT s.id, s.name, ST_X(s.geom::geometry), ST_Y(s.geom::geometry),
                   coalesce(array_agg(r.name) FILTER (WHERE r.source = 'kakao'), '{}'),
                   coalesce(array_agg(r.payload->>'id') FILTER (WHERE r.source = 'kakao'), '{}'),
                   greatest(s.last_mention_on, (SELECT max(f.posted_on) FROM shop_facts f WHERE f.shop_id = s.id)),
                   coalesce(s.address, s.road_address), s.road_address, coalesce(s.aliases, '{}'),
                   EXISTS (SELECT 1 FROM shop_checks c WHERE c.shop_id = s.id AND c.trigger = 'reports')
            FROM shops s LEFT JOIN raw_sources r ON r.shop_id = s.id
            WHERE s.status = 'suspended'
              AND NOT EXISTS (  -- an 'unsure' answer waits a while before asking again
                  SELECT 1 FROM shop_checks c WHERE c.shop_id = s.id AND c.result = 'unsure'
                    AND c.checked_at > now() - make_interval(days => %s))
            GROUP BY s.id ORDER BY s.id"""
        params: list = [RECHECK_UNSURE_DAYS]
        if limit:
            sql += " LIMIT %s"
            params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        recent_since = conn.execute("SELECT (now() - make_interval(days => %s))::date", (RECENT_DAYS,)).fetchone()[0]
        stats.update(checked=len(rows), open=0, closed=0, unsure=0, fresh_searches=0)
        search = KakaoSearch()

        for shop_id, name, lon, lat, kakao_names, place_ids, last_mention, address, road_address, aliases, reported in rows:
            kakao = still_on_kakao([*kakao_names, name], set(place_ids), lon, lat)
            recent = last_mention is not None and last_mention >= recent_since
            if kakao["found"] and not recent:
                last_mention = max(filter(None, [last_mention, latest_post(search, name, kakao_names, aliases, address, road_address)]), default=None)
                recent = last_mention is not None and last_mention >= recent_since
                stats["fresh_searches"] += 1
            if kakao["found"] and recent:
                result, status = "open", "candidate"
            elif not kakao["found"] and (place_ids or reported):
                result, status = "closed", "closed"
            else:
                result, status = "unsure", None
            detail = {**kakao, "last_mention_on": last_mention.isoformat() if last_mention else None}
            with conn.transaction():
                if status:
                    conn.execute("UPDATE shops SET status = %s WHERE id = %s AND status = 'suspended'", (status, shop_id))
                conn.execute(
                    "INSERT INTO shop_checks (shop_id, trigger, result, detail) VALUES (%s, 'pipeline', %s, %s)",
                    (shop_id, result, json.dumps(detail, ensure_ascii=False)),
                )
            stats[result] += 1
    return stats


def suspend(conn, shop_id: int, kind: str, detail: dict) -> bool:
    with conn.transaction():
        changed = conn.execute("UPDATE shops SET status = 'suspended' WHERE id = %s AND status = 'candidate'", (shop_id,)).rowcount
        if changed:
            conn.execute(
                "INSERT INTO shop_checks (shop_id, kind, trigger, result, detail) VALUES (%s, %s, 'pipeline', 'suspended', %s)",
                (shop_id, kind, json.dumps(detail, ensure_ascii=False, default=str)),
            )
    return bool(changed)


def stale_check(limit: int) -> dict:
    """Shops nobody has written about for a year: still on Kakao Map? If not, suspend for the re-check."""
    with connect() as conn, pipeline_run(conn, "closures_stale") as stats:
        rows = conn.execute(
            """SELECT s.id, s.name, ST_X(s.geom::geometry), ST_Y(s.geom::geometry), s.last_mention_on,
                      coalesce(array_agg(r.name) FILTER (WHERE r.source = 'kakao'), '{}'),
                      coalesce(array_agg(r.payload->>'id') FILTER (WHERE r.source = 'kakao'), '{}')
               FROM shops s LEFT JOIN raw_sources r ON r.shop_id = s.id
               WHERE s.status = 'candidate' AND s.kind = 'store' AND s.category <> 'excluded'
                 AND s.last_mention_on < now() - make_interval(days => %s)
                 AND NOT EXISTS (SELECT 1 FROM shop_checks c WHERE c.shop_id = s.id AND c.kind = 'stale'
                                 AND c.checked_at > now() - make_interval(days => %s))
               GROUP BY s.id
               HAVING count(*) FILTER (WHERE r.source = 'kakao') > 0  -- public-data-only names can't be looked up reliably
               ORDER BY s.last_mention_on LIMIT %s""",
            (STALE_AFTER_DAYS, STALE_RECHECK_DAYS, limit),
        ).fetchall()
        stats.update(checked=len(rows), suspended=0, still_listed=0)
        for shop_id, name, lon, lat, last_mention, kakao_names, place_ids in rows:
            kakao = still_on_kakao([*kakao_names, name], set(place_ids), lon, lat)
            detail = {**kakao, "last_mention_on": last_mention}
            if kakao["found"]:
                conn.execute(
                    "INSERT INTO shop_checks (shop_id, kind, trigger, result, detail) VALUES (%s, 'stale', 'pipeline', 'open', %s)",
                    (shop_id, json.dumps(detail, ensure_ascii=False, default=str)),
                )
                conn.commit()
                stats["still_listed"] += 1
            elif suspend(conn, shop_id, "stale", detail):
                stats["suspended"] += 1
    return stats


def vanished(sweep_started) -> dict:
    """After a complete Kakao sweep: shops whose Kakao places all failed to come back. Suspends them for the re-check."""
    with connect() as conn, pipeline_run(conn, "closures_vanished") as stats:
        linked = conn.execute(
            """SELECT count(DISTINCT s.id) FROM shops s JOIN raw_sources r ON r.shop_id = s.id AND r.source = 'kakao'
               WHERE s.status = 'candidate'"""
        ).fetchone()[0]
        gone = [
            r[0] for r in conn.execute(
                """SELECT s.id FROM shops s JOIN raw_sources r ON r.shop_id = s.id AND r.source = 'kakao'
                   WHERE s.status = 'candidate' AND s.kind = 'store'
                   GROUP BY s.id HAVING max(r.fetched_at) < %s""",
                (sweep_started,),
            )
        ]
        stats.update(linked=linked, vanished=len(gone), suspended=0)
        if linked and len(gone) / linked > VANISHED_MAX_SHARE:
            stats["skipped"] = f"{len(gone)}/{linked} vanished is more than {VANISHED_MAX_SHARE:.0%}: sweep looks incomplete"
            return stats
        for shop_id in gone:
            stats["suspended"] += suspend(conn, shop_id, "vanished", {"sweep_started": sweep_started})
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int)
    p.add_argument("--stale", type=int, help="also check up to N shops with no mention for a year")
    a = p.parse_args()
    if a.stale:
        print(json.dumps(stale_check(a.stale), ensure_ascii=False, indent=2, default=str))
    print(json.dumps(run(a.limit), ensure_ascii=False, indent=2, default=str))
