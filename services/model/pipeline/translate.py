"""Pipeline step: English for the Korean texts AI wrote, for the app's English mode.

Collects texts without an English version yet — region names and intros, preset titles and intros first (few, seen
by everyone), then shop summaries and reasons (most-mentioned shops first) — and translates them in batches into
`translations` (ko → en). The API swaps them in when a request asks for English; anything not translated yet stays
Korean. Text-keyed, so a preset rebuilt with the same words isn't translated again.

Usage: python -m pipeline.translate [--limit 400] [--batch 40]
"""

import argparse
import json

from pydantic import BaseModel

from ai import generate
from pipeline.db import connect, pipeline_run

SYSTEM = """You translate short Korean texts from a Seoul clothing-shop walking app into natural English for visitors.

- Keep it short and plain, like the original (a one-line description stays one line). No quotes, no extra words.
- Seoul place names in their usual English spelling: 성수 → Seongsu, 홍대·연남 → Hongdae · Yeonnam, 동묘 → Dongmyo,
  명동 → Myeongdong, 한남 → Hannam, 가로수길 → Garosu-gil, 압구정로데오 → Apgujeong Rodeo, 을지로 → Euljiro.
- Brand and shop names: their usual English/Latin spelling if they have one (아더에러 → ADER ERROR, 무신사 → Musinsa),
  else romanize. Fashion words as fashion people say them (구제 → thrift, 편집숍 → select shop, 아메카지 → amekaji).
- kind tells what the text is: region_name is a neighbourhood name (just the name), station is a subway station
  (its English name as on Seoul Metro signs: 성수역 → Seongsu Station, 홍대입구역 → Hongik Univ. Station,
  을지로3가역 → Euljiro 3(sam)-ga Station), place is a neighbourhood or building name (망원동 → Mangwon-dong),
  the rest are descriptions."""


class Pair(BaseModel):
    i: int
    en: str


class Batch(BaseModel):
    items: list[Pair]


SOURCES = [
    ("region_name", "SELECT name FROM regions"),
    ("region_intro", "SELECT intro FROM regions WHERE intro IS NOT NULL"),
    ("preset_title", "SELECT title FROM presets"),
    ("preset_intro", "SELECT intro FROM presets WHERE intro IS NOT NULL"),
    # Subway stations courses start from (a region's stations, and the ones courses actually used).
    ("station", "SELECT DISTINCT unnest(stations) FROM regions"),
    ("station", "SELECT DISTINCT request->>'startName' FROM courses WHERE request->>'startName' ~ '역$'"),
    ("station", "SELECT DISTINCT request->'end'->>'name' FROM courses WHERE request->'end'->>'name' ~ '역$'"),
    # Other places courses start or end at (neighbourhoods, buildings picked on the map).
    ("place", """SELECT DISTINCT n FROM (SELECT request->>'startName' AS n FROM courses UNION SELECT request->'end'->>'name' FROM courses) x
                 WHERE n ~ '[가-힣]' AND n !~ '역$' AND n NOT IN ('내 위치', '고른 위치', '고른 곳', '출발점', '끝나는 곳')"""),
    ("shop_summary", """SELECT summary FROM shops WHERE status = 'candidate' AND summary IS NOT NULL
                        ORDER BY coalesce(matched_posts, 0) DESC, id"""),
    ("shop_reason", """SELECT reason_material FROM shops WHERE status = 'candidate' AND reason_material IS NOT NULL
                       ORDER BY coalesce(matched_posts, 0) DESC, id"""),
]


def pending(conn, limit: int | None) -> list[tuple[str, str]]:
    """(kind, text) still without English, in priority order."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for kind, sql in SOURCES:
        for (text,) in conn.execute(
            f"SELECT t FROM ({sql}) AS src(t) WHERE t <> '' AND NOT EXISTS (SELECT 1 FROM translations x WHERE x.ko = src.t)"
        ).fetchall():
            if text not in seen:
                seen.add(text)
                out.append((kind, text))
                if limit and len(out) >= limit:
                    return out
    return out


def run(limit: int | None, batch: int) -> dict:
    with connect() as conn, pipeline_run(conn, "translate") as stats:
        todo = pending(conn, limit)
        stats.update(texts=len(todo), done=0)
        for start in range(0, len(todo), batch):
            chunk = todo[start : start + batch]
            prompt = "Translate each text. Answer with the same i.\n\n" + json.dumps(
                [{"i": i, "kind": k, "ko": t} for i, (k, t) in enumerate(chunk)], ensure_ascii=False
            )
            result = generate(purpose="translate", system=SYSTEM, prompt=prompt, schema=Batch, tier="fast", conn=conn, run_id=stats["run_id"])
            for p in result.items:
                if 0 <= p.i < len(chunk) and p.en.strip():
                    kind, ko = chunk[p.i]
                    conn.execute(
                        "INSERT INTO translations (ko, en, kind) VALUES (%s, %s, %s) ON CONFLICT (ko) DO NOTHING",
                        (ko, p.en.strip()[:600], kind),
                    )
                    stats["done"] += 1
            conn.commit()
            print(f"  {min(start + batch, len(todo))}/{len(todo)} (translated {stats['done']})", flush=True)
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int)
    p.add_argument("--batch", type=int, default=40)
    a = p.parse_args()
    print(json.dumps(run(a.limit, a.batch), ensure_ascii=False, indent=2))
