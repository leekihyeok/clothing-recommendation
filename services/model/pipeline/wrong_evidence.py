"""Pipeline step (after ⑥ verify): shops whose collected posts turned out to be about something else.

Verify gives confidence 0 when the evidence is about another place or another thing altogether: a common-word name
("초이스", "드림") picks up phone-plan posts, a "홍대빈티지" gets 압구정빈티지's posts. Everything read from those posts is
wrong, so it is dropped and the shop becomes a plain "정보가 적은 가게" (exists, little known):
  - summary, reason, items, price range, style scores, blog reputation, the "비슷한 가게" embedding
  - opening hours read from posts (an owner's own hours stay), brands read from posts (brands from the name stay),
    "누구 옷" the AI read from posts
  - the posts themselves (shop_facts), so the shop page shows no 근거 글 and steps don't re-read them
  - matched_posts → 0: the wrong posts no longer count as popularity
Confidence stays 0, so recommendations rank these shops last unless someone pins or names them.

Shops known only from the public data (no Kakao Map place) with such evidence are most likely gone: suspended for the
closure re-check (pipeline.closures), which keeps them out of courses unless people say otherwise.

Usage: python -m pipeline.wrong_evidence [--dry-run]
"""

import argparse
import json

from pipeline.closures import suspend
from pipeline.db import connect, pipeline_run

TODO_SQL = """SELECT s.id, s.name, s.verify_note,
                     EXISTS (SELECT 1 FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao') AS on_kakao
              FROM shops s
              WHERE s.confidence = 0 AND s.evidence_rejected_at IS NULL AND s.status = 'candidate'"""


def run(dry_run: bool) -> dict:
    with connect() as conn, pipeline_run(conn, "wrong_evidence") as stats:
        rows = conn.execute(TODO_SQL).fetchall()
        stats.update(shops=len(rows), cleared=0, suspended=0)
        if dry_run:
            stats["not_on_kakao"] = sum(1 for r in rows if not r[3])
            return stats
        for shop_id, name, note, on_kakao in rows:
            with conn.transaction():
                conn.execute(
                    """UPDATE shops SET summary = NULL, reason_material = NULL, items = NULL, price_range = NULL,
                              blog_score = NULL, blog_pros = NULL, blog_cons = NULL,
                              embedding = NULL, embedded_at = NULL, matched_posts = 0,
                              gender = CASE WHEN gender_source = 'ai' THEN NULL ELSE gender END,
                              gender_source = CASE WHEN gender_source = 'ai' THEN NULL ELSE gender_source END,
                              evidence_rejected_at = now()
                       WHERE id = %s""",
                    (shop_id,),
                )
                # Hours read from posts (an owner's hours live in shop_owner_info and are untouched).
                conn.execute(
                    "UPDATE shops SET hours = NULL, hours_note = NULL, hours_url = NULL, hours_posted_on = NULL WHERE id = %s",
                    (shop_id,),
                )
                conn.execute("DELETE FROM shop_style_scores WHERE shop_id = %s", (shop_id,))
                conn.execute("DELETE FROM shop_brands WHERE shop_id = %s AND source = 'blog'", (shop_id,))
                conn.execute("DELETE FROM shop_facts WHERE shop_id = %s", (shop_id,))
            stats["cleared"] += 1
            if not on_kakao and suspend(conn, shop_id, "wrong_evidence", {"name": name, "verify_note": (note or "")[-300:]}):
                stats["suspended"] += 1
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    print(json.dumps(run(a.dry_run), ensure_ascii=False, indent=2))
