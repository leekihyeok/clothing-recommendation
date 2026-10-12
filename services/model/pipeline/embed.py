"""Pipeline step: shop embeddings for "비슷한 가게" (similar shops on the shop page).

Each scored shop becomes one short text — its kind, summary, what makes it worth a visit, its strongest styles, items
and price range — embedded with Gemini (gemini-embedding-001, 768 dimensions, SEMANTIC_SIMILARITY) into
shops.embedding. Up to 100 texts per call; the embedding model has its own free quota, apart from the generate
models the other steps share — but every text counts as one request, 1,000 a day (2026-10-12). So a day embeds at
most DAILY_CAP shops and then stops quietly until the quota day turns (midnight Pacific), instead of failing; the
refresh loop picks the rest up on the following days. Re-runs only shops scored again since they were embedded.

Usage: python -m pipeline.embed [--region 성수] [--limit 500]
"""

import argparse
import json
import time

from ai import AIError
from ai.client import QUOTA_DAY_TZ, _gemini, _log
from app.catalog import load_catalog
from pipeline.db import connect, pipeline_run

MODEL = "gemini-embedding-001"
DIMENSIONS = 768
BATCH = 100
PAUSE_S = 1.0  # well under the free tier's per-minute limit
DAILY_CAP = 950  # of the free tier's 1,000 texts a day

CATALOG = load_catalog()
STYLE_LABEL = {s.id: s.label for s in CATALOG.styles}
ITEM_LABEL = {i.id: i.label for i in CATALOG.items}
KIND_LABEL = {"select_shop": "편집숍", "vintage": "빈티지·구제 숍", "brand": "브랜드 매장", "spa": "SPA 매장", "general": "옷가게", "complex": "백화점·몰"}
PRICE_LABEL = {"low": "저렴한 편", "mid": "중간 가격", "high": "고가"}


def text_for(category: str, summary: str | None, reason: str | None, styles: dict | None, items: list | None, price: str | None) -> str:
    """What the shop is like, in words — not its name or place, so similar means similar to visit."""
    top = sorted((styles or {}).items(), key=lambda kv: -kv[1])
    parts = [
        KIND_LABEL.get(category, "옷가게"),
        summary or "",
        reason or "",
        "스타일: " + ", ".join(STYLE_LABEL.get(k, k) for k, v in top if v >= 5) if any(v >= 5 for _, v in top) else "",
        "품목: " + ", ".join(ITEM_LABEL.get(i, i) for i in items or []) if items else "",
        PRICE_LABEL.get(price or "", ""),
    ]
    return " · ".join(p for p in parts if p)


class DailyQuota(Exception):
    """The day's embedding quota is used up."""


def embedded_today(conn) -> int:
    """Shops embedded since the quota day began (each one was a request)."""
    return conn.execute(
        """SELECT count(*) FROM shops
           WHERE embedded_at >= date_trunc('day', now() AT TIME ZONE %s) AT TIME ZONE %s""",
        (QUOTA_DAY_TZ, QUOTA_DAY_TZ),
    ).fetchone()[0]


def embed(texts: list[str], conn, run_id: int) -> list[list[float]]:
    from google.genai import errors, types

    t0 = time.monotonic()
    for attempt in range(4):
        try:
            res = _gemini().models.embed_content(
                model=MODEL, contents=texts,
                config=types.EmbedContentConfig(output_dimensionality=DIMENSIONS, task_type="SEMANTIC_SIMILARITY"),
            )
            _log(conn, run_id, "shop_embedding", MODEL, None, int((time.monotonic() - t0) * 1000), ok=True, requested=MODEL)
            return [e.values for e in res.embeddings]
        except errors.APIError as e:
            if e.code == 429 and "PerDay" in str(e):
                raise DailyQuota() from e
            if attempt == 3 or e.code not in (429, 500, 503):
                _log(conn, run_id, "shop_embedding", MODEL, None, int((time.monotonic() - t0) * 1000), ok=False, error=str(e)[:300], requested=MODEL)
                raise AIError(f"embedding failed: {e}") from e
            time.sleep(15 * (attempt + 1))
    raise AIError("embedding failed")


def run(region: str | None, limit: int | None, categories: list[str] | None = None) -> dict:
    with connect() as conn, pipeline_run(conn, "embed") as stats:
        sql = """SELECT s.id, s.category, s.summary, s.reason_material, s.items, s.price_range,
                        (SELECT jsonb_object_agg(style_id, score) FROM shop_style_scores x WHERE x.shop_id = s.id)
                 FROM shops s
                 WHERE s.status = 'candidate' AND s.summary IS NOT NULL AND s.scored_at IS NOT NULL
                   AND (s.embedded_at IS NULL OR s.embedded_at < s.scored_at)"""
        params: list = []
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
        rows = conn.execute(sql, params).fetchall()
        left = max(0, DAILY_CAP - embedded_today(conn))
        stats.update(region=region, shops=len(rows), done=0, left_today=left)
        rows = rows[:left]
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            try:
                vectors = embed([text_for(c, sm, rs, st, it, pr) for _, c, sm, rs, it, pr, st in chunk], conn, stats["run_id"])
            except DailyQuota:
                stats["stopped"] = "daily quota"
                break
            for (shop_id, *_), v in zip(chunk, vectors):
                conn.execute("UPDATE shops SET embedding = %s::vector, embedded_at = now() WHERE id = %s", (json.dumps(v), shop_id))
            conn.commit()
            stats["done"] += len(chunk)
            print(f"  {stats['done']}/{len(rows)}", flush=True)
            time.sleep(PAUSE_S)
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--region")
    p.add_argument("--limit", type=int)
    a = p.parse_args()
    print(json.dumps(run(a.region, a.limit), ensure_ascii=False, indent=2))
