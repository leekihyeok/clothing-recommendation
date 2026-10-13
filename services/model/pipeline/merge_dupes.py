"""Pipeline step: merge shops listed twice under different scripts.

Step ②-c (dedupe) links Kakao places to public-data shops by Korean name similarity, so "EQL 성수점" (Kakao) and
"이큐엘 성수점" (public data) at the same address stayed two shops and both turned up in one course. Here two candidate
stores are the same shop when they are at the same road address (or within 15 m) and their names agree once the scripts
are bridged:
  - Latin letters read out the Korean way: EQL → 이큐엘, MLB → 엠엘비
  - Korean romanized (Revised Romanization, simplified): 모노하 → monoha = "MO-NO-HA"
  - or close after that (similarity ≥ 0.82): 무신사 스탠다드 ↔ MUSINSA STANDARD
  - or both start with the same brand from the brand dictionary and the rest is only places and store words:
    "Supreme도산" ↔ "슈프림" (a loanword doesn't romanize back: 슈프림 → syupeurim), "커버낫성수플래그십" ↔
    "커버낫 플래그쉽 성수점". A product line or a unit keeps them apart: 헤지스골프 / 헤지스ACC, 뉴발란스키즈.
Branch words ("성수점"), brackets, spaces and case are ignored. Department stores, malls and market stalls are left
alone (many shops share one address there).

The shop that stays is the one we know more about (on Kakao, scored, more posts, user records). The other one becomes
status 'merged' with merged_into set, and its sources, evidence, user records, reviews and owner data move over.
Nothing is deleted. Re-running only looks at shops still 'candidate'.

Usage: python -m pipeline.merge_dupes [--dry-run]
"""

import argparse
import json
import re
from difflib import SequenceMatcher

from pipeline.brands import place_words
from pipeline.db import connect, pipeline_run

SAME_SPOT_M = 15
SIMILAR = 0.82

LETTER = {
    "a": "에이", "b": "비", "c": "씨", "d": "디", "e": "이", "f": "에프", "g": "지", "h": "에이치", "i": "아이", "j": "제이",
    "k": "케이", "l": "엘", "m": "엠", "n": "엔", "o": "오", "p": "피", "q": "큐", "r": "알", "s": "에스", "t": "티", "u": "유",
    "v": "브이", "w": "더블유", "x": "엑스", "y": "와이", "z": "지",
}
# Revised Romanization, without the sound-change rules: close enough to compare brand spellings.
CHO = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
JUNG = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
JONG = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]


def core(name: str) -> str:
    """Lower case, no brackets, no trailing branch word (…점), no spaces or punctuation."""
    name = re.sub(r"\(.*?\)|\[.*?\]", "", name)
    name = re.sub(r"\s*\S*점$", "", name.strip()) or name
    return re.sub(r"[^0-9a-z가-힣]", "", name.lower())


def romanize(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch) - 0xAC00
        if 0 <= code < 11172:
            out.append(CHO[code // 588] + JUNG[(code % 588) // 28] + JONG[code % 28])
        else:
            out.append(ch)
    return "".join(out)


def letters(text: str) -> str:
    """Latin letters read out one by one, Korean style (for acronyms)."""
    return "".join(LETTER.get(ch, ch) for ch in text)


# Not shop names: two stalls both called "노점" at one address are not one shop.
GENERIC = {"업소명없음", "상호없음", "노점", "옷가게", "의류", "잡화", "패션", "상가", "매장", "가게", "의류판매", "구제", "빈티지"}


def same_name(a: str, b: str) -> str | None:
    """How two names were found to be the same, or None."""
    ca, cb = core(a), core(b)
    if len(ca) < 2 or len(cb) < 2 or ca in GENERIC or cb in GENERIC:
        return None
    if ca == cb:
        return "same"
    # Unit numbers ("6129호" / "4045호") mark different shops in one building.
    if re.sub(r"\D", "", ca) != re.sub(r"\D", "", cb):
        return None
    hangul_a, hangul_b = bool(re.search(r"[가-힣]", ca)), bool(re.search(r"[가-힣]", cb))
    latin_a, latin_b = bool(re.search(r"[a-z]", ca)), bool(re.search(r"[a-z]", cb))
    if not ((latin_a and hangul_b) or (latin_b and hangul_a)):
        return None  # same script, different name: dedupe already compared these
    for x, y in ((ca, cb), (cb, ca)):
        if letters(x) == y:
            return "letters"
    ra, rb = romanize(ca), romanize(cb)
    if ra == rb:
        return "romanized"
    ratio = SequenceMatcher(None, ra, rb).ratio()
    # Only between a purely Latin name and a purely Korean one ("어니언" / "Onion"): with both scripts in a name,
    # a shared word is enough to look similar ("질스튜어트ACC" / "질스튜어트" are two shops).
    pure = (not latin_a and not hangul_b) or (not hangul_a and not latin_b)
    if pure and ratio >= SIMILAR:
        return f"similar {ratio:.2f}"
    # "MLB 명동점" / "엠엘비 명동": the brand word alone, when one side is Latin and the other Korean.
    ta, tb = core(a.split()[0]), core(b.split()[0])
    if len(ta) >= 2 and len(tb) >= 2 and ta != ca + "x" and (letters(ta) == tb or letters(tb) == ta or (romanize(ta) == romanize(tb) and ta != tb)):
        return "brand word"
    return None


# What may follow a brand in one store's name and not make it another shop: store words and places.
STORE_WORDS = {
    "플래그십스토어", "플래그쉽스토어", "플래그십", "플래그쉽", "flagship", "스토어", "store", "직영점", "직영", "대리점", "본점",
    "매장", "코리아", "korea", "서울", "seoul", "점",
}
# Places shops are named after that aren't a station or a 동 (place_words has those).
EXTRA_PLACES = {"도산", "도산공원", "가로수", "가로수길", "로데오"}


def brand_split(name: str, aliases: list[tuple[str, str]]) -> tuple[str, str] | None:
    """(brand key, the rest) for a core name starting with a brand spelling, the longest one that fits."""
    for alias, key in aliases:
        if name.startswith(alias):
            return key, name[len(alias):]
    return None


def only_branch(rest: str, words: list[str]) -> bool:
    """Whether what follows the brand is only places and store words ("도산", "성수플래그십", "종로5가점")."""
    rest = re.sub(r"\d+가", "", rest)  # 종로5가 (the digits are compared on the whole name)
    while rest:
        w = next((w for w in words if rest.startswith(w) or rest.endswith(w)), None)
        if not w:
            return False
        rest = rest[len(w):] if rest.startswith(w) else rest[: -len(w)]
    return True


def same_brand_store(a: str, b: str, aliases: list[tuple[str, str]], words: list[str]) -> str | None:
    """Two names for one brand store: the same brand, then nothing but where it is (see the module docstring)."""
    ca, cb = core(a), core(b)
    if ca == cb or re.sub(r"\D", "", ca) != re.sub(r"\D", "", cb):
        return None
    sa, sb = brand_split(ca, aliases), brand_split(cb, aliases)
    if not sa or not sb or sa[0] != sb[0]:
        return None
    return f"brand {sa[0]}" if only_branch(sa[1], words) and only_branch(sb[1], words) else None


def brand_aliases(conn) -> list[tuple[str, str]]:
    """Every brand spelling (Hangul 2+, Latin 3+ letters) with its key, longest first."""
    out = [
        (alias, key)
        for key, aliases in conn.execute("SELECT key, aliases FROM brands").fetchall()
        for alias in aliases or []
        if len(alias) >= (2 if re.search(r"[가-힣]", alias) else 3)
    ]
    return sorted(out, key=lambda x: -len(x[0]))


def branch_words(conn) -> list[str]:
    """Store words and places, longest first (so "플래그십스토어" goes before "스토어")."""
    regions = {p for (name,) in conn.execute("SELECT name FROM regions").fetchall() for p in name.split("·")}
    return sorted(STORE_WORDS | EXTRA_PLACES | place_words(conn) | regions, key=lambda w: -len(w))


def pairs(conn) -> list[tuple]:
    return conn.execute(
        f"""SELECT a.id, a.name, b.id, b.name,
                   coalesce((SELECT r.name FROM raw_sources r WHERE r.shop_id = a.id AND r.source = 'kakao' LIMIT 1), a.name),
                   coalesce((SELECT r.name FROM raw_sources r WHERE r.shop_id = b.id AND r.source = 'kakao' LIMIT 1), b.name)
            FROM shops a JOIN shops b ON a.id < b.id
             AND (ST_DWithin(a.geom, b.geom, {SAME_SPOT_M})
                  OR (a.road_address IS NOT NULL AND replace(replace(a.road_address, '서울특별시', '서울'), ' ', '')
                                                   = replace(replace(b.road_address, '서울특별시', '서울'), ' ', '')))
            WHERE a.status = 'candidate' AND b.status = 'candidate' AND a.kind = 'store' AND b.kind = 'store'
              AND a.category <> 'excluded' AND b.category <> 'excluded' AND NOT a.in_market AND NOT b.in_market"""
    ).fetchall()


def richness(conn, shop_id: int) -> tuple:
    """Which of two to keep: on Kakao, user records, scored, posts — in that order."""
    return conn.execute(
        """SELECT EXISTS (SELECT 1 FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao'),
                  (SELECT count(*) FROM user_shop_events e WHERE e.shop_id = s.id) + (SELECT count(*) FROM shop_reviews v WHERE v.shop_id = s.id),
                  s.scored_at IS NOT NULL, coalesce(s.matched_posts, 0), -s.id
           FROM shops s WHERE s.id = %s""",
        (shop_id,),
    ).fetchone()


def merge(conn, keep: int, gone: int) -> None:
    """Move everything about `gone` onto `keep` (rows that would clash stay with `gone`, which is hidden anyway)."""
    conn.execute("UPDATE raw_sources SET shop_id = %s WHERE shop_id = %s", (keep, gone))
    conn.execute(
        """UPDATE shop_facts f SET shop_id = %s WHERE shop_id = %s
           AND NOT EXISTS (SELECT 1 FROM shop_facts k WHERE k.shop_id = %s AND k.kind = f.kind AND k.url = f.url)""",
        (keep, gone, keep),
    )
    conn.execute("UPDATE user_shop_events SET shop_id = %s WHERE shop_id = %s", (keep, gone))
    conn.execute(
        """UPDATE shop_reviews r SET shop_id = %s WHERE shop_id = %s
           AND NOT EXISTS (SELECT 1 FROM shop_reviews k WHERE k.shop_id = %s AND k.user_id = r.user_id)""",
        (keep, gone, keep),
    )
    conn.execute("UPDATE shop_checks SET shop_id = %s WHERE shop_id = %s", (keep, gone))
    conn.execute("UPDATE shop_owner_claims SET shop_id = %s WHERE shop_id = %s", (keep, gone))
    conn.execute(
        """UPDATE shop_owners o SET shop_id = %s WHERE shop_id = %s
           AND NOT EXISTS (SELECT 1 FROM shop_owners k WHERE k.shop_id = %s AND k.user_id = o.user_id)""",
        (keep, gone, keep),
    )
    conn.execute(
        "UPDATE shop_owner_info SET shop_id = %s WHERE shop_id = %s AND NOT EXISTS (SELECT 1 FROM shop_owner_info WHERE shop_id = %s)",
        (keep, gone, keep),
    )
    # Style scores: the kept shop's own if it has them, otherwise the other's.
    conn.execute(
        """UPDATE shop_style_scores SET shop_id = %s WHERE shop_id = %s
           AND NOT EXISTS (SELECT 1 FROM shop_style_scores WHERE shop_id = %s)""",
        (keep, gone, keep),
    )
    conn.execute(
        """UPDATE shops k SET
             summary = coalesce(k.summary, g.summary), reason_material = coalesce(k.reason_material, g.reason_material),
             items = coalesce(k.items, g.items), price_range = coalesce(k.price_range, g.price_range),
             matched_posts = greatest(coalesce(k.matched_posts, 0), coalesce(g.matched_posts, 0)),
             last_mention_on = greatest(k.last_mention_on, g.last_mention_on),
             scored_at = coalesce(k.scored_at, g.scored_at), confidence = greatest(k.confidence, g.confidence)
           FROM shops g WHERE k.id = %s AND g.id = %s""",
        (keep, gone),
    )
    conn.execute("UPDATE shops SET status = 'merged', merged_into = %s WHERE id = %s", (keep, gone))


def run(dry_run: bool) -> dict:
    with connect() as conn, pipeline_run(conn, "merge_dupes") as stats:
        found = []
        aliases, words = brand_aliases(conn), branch_words(conn)
        for a_id, a_name, b_id, b_name, a_shown, b_shown in pairs(conn):
            how = (
                same_name(a_shown, b_shown)
                or same_name(a_name, b_name)
                or same_brand_store(a_shown, b_shown, aliases, words)
                or same_brand_store(a_name, b_name, aliases, words)
            )
            if how:
                found.append((a_id, a_shown, b_id, b_shown, how))
        stats.update(pairs_checked=0, found=len(found), merged=0, examples=[f"{a} = {b} ({how})" for _, a, _, b, how in found[:80]])
        if dry_run:
            conn.rollback()
            return stats
        done: set[int] = set()
        for a_id, _, b_id, _, _ in found:
            if a_id in done or b_id in done:
                continue  # chains (A=B, B=C) settle on the next run
            keep, gone = (a_id, b_id) if richness(conn, a_id) >= richness(conn, b_id) else (b_id, a_id)
            with conn.transaction():
                merge(conn, keep, gone)
            done.update((a_id, b_id))
            stats["merged"] += 1
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="list what would be merged, change nothing")
    print(json.dumps(run(p.parse_args().dry_run), ensure_ascii=False, indent=2))
