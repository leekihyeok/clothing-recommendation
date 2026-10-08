"""Runs steps ④ evidence (+ AI aliases for shops nothing was found for) → ⑤ score → ⑥ verify for every region (largest first), then for the rest of Seoul.

Two passes: first only the shop types courses are built from (편집숍, 빈티지, 브랜드) in every region, then everything
else. Most shops are plain 옷가게, so without the first pass a region's distinctive shops waited behind the previous
region's plain ones, and courses and presets outside the first few regions ran on category guesses for days.

Meant to run unattended for hours or days on the free tiers: when an AI or search call keeps failing (daily quota,
"high demand"), it waits and retries the same step. Every step only picks up shops it hasn't finished, so stopping and
starting again resumes where it left off. Create data/logs/STOP to stop after the current step.

Usage: python -m pipeline.quality_run [--only-regions]
"""

import argparse
import time
import traceback
from datetime import datetime

from ai import AIError
from app.settings import REPO_ROOT
from pipeline import aliases, blogs, closures, gender, presets, recheck_category, reputation, score, verify
from pipeline.db import connect

STOP_FILE = REPO_ROOT / "data" / "logs" / "STOP"
WAIT_ON_FAILURE_S = 20 * 60


def log(msg: str) -> None:
    print(f"[{datetime.now():%m-%d %H:%M:%S}] {msg}", flush=True)


# Pass 1: the shop types style courses are made of.
PRIORITY = ["select_shop", "vintage", "brand"]


def remaining(region: str | None, categories: list[str] | None = None) -> tuple[int, int, int, int]:
    in_region = "" if region is None else "AND EXISTS (SELECT 1 FROM regions g WHERE g.name = %(r)s AND ST_Intersects(g.polygon, s.geom))"
    if categories:
        in_region += " AND s.category = ANY(%(c)s)"
    with connect() as conn:
        return conn.execute(
            f"""SELECT count(*) FILTER (WHERE s.evidence_at IS NULL),
                       count(*) FILTER (WHERE s.evidence_at IS NOT NULL AND s.scored_at IS NULL),
                       count(*) FILTER (WHERE s.scored_at IS NOT NULL AND s.confidence IS NULL),
                       count(*) FILTER (WHERE coalesce(s.matched_posts, 0) > 0 AND s.evidence_at IS NOT NULL
                                          AND (s.reputation_at IS NULL OR s.reputation_at < s.evidence_at))
                FROM shops s
                WHERE s.kind = 'store' AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
                {in_region}""",
            {"r": region, "c": categories},
        ).fetchone()


def step(name: str, fn) -> None:
    while True:
        if STOP_FILE.exists():
            raise SystemExit("STOP file found")
        try:
            result = fn()
            log(f"  {name}: {result}")
            return
        except (AIError, RuntimeError) as e:  # quota, overload, network: wait it out
            log(f"  {name} failed: {e!s:.300} — retrying in {WAIT_ON_FAILURE_S // 60} min")
            time.sleep(WAIT_ON_FAILURE_S)
        except Exception:
            log(f"  {name} crashed:\n{traceback.format_exc()}")
            time.sleep(WAIT_ON_FAILURE_S)


def suspended() -> int:
    with connect() as conn:
        return conn.execute("SELECT count(*) FROM shops WHERE status = 'suspended'").fetchone()[0]


def process(region: str | None, categories: list[str] | None = None) -> None:
    label = (region or "서울 나머지") + (" (편집숍·빈티지·브랜드)" if categories else "")
    # Shops "문 닫혀 있었어요" reports took out get re-checked between regions (Kakao only, no AI).
    if suspended():
        step("closures", lambda: _short(closures.run(None)))
    todo = remaining(region, categories)
    log(f"{label}: evidence {todo[0]}, score {todo[1]}, verify {todo[2]}, reputation {todo[3]} to go")
    if not any(todo):
        return
    step("evidence", lambda: _short(blogs.run(region, None, 30, retry_empty=False, categories=categories)))
    step("aliases", lambda: _short(aliases.run(region, None, categories=categories)))
    step("score", lambda: _short(score.run(region, None, False, 8, categories=categories)))
    step("verify", lambda: _short(verify.run(region, None, 8, categories=categories)))
    step("reputation", lambda: _short(reputation.run(region, None, 10, categories=categories)))
    # Scores and summaries now exist: fix categories the name alone got wrong ("오티코티" brand → vintage).
    step("recheck category", lambda: {"changed": recheck_category.run(False, region)["changed"]})
    step("gender", lambda: {"changed": gender.run(False)["changed"]})
    # More shops with real style scores → better first-screen ideas. One AI call.
    if region is not None:
        step("presets", lambda: {"presets": len(presets.run(2, 8, False)["presets"])})


def _short(stats: dict) -> dict:
    return {k: v for k, v in stats.items() if k not in ("run_id", "region")}


def main(only_regions: bool) -> None:
    with connect() as conn:
        regions = [r[0] for r in conn.execute("SELECT name FROM regions ORDER BY shop_count DESC")]
    log(f"start: {len(regions)} regions" + ("" if only_regions else ", then the rest of Seoul"))
    for region in regions:
        process(region, PRIORITY)
    for region in regions:
        process(region)
    if not only_regions:
        process(None)
    # Shops scored before the name-variant / address / alias searches existed: search them again once.
    step("retry empty", lambda: _short(blogs.run(None, None, 30, retry_empty=True)))
    step("aliases (all)", lambda: _short(aliases.run(None, None)))
    process(None)
    log("done")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--only-regions", action="store_true")
    main(p.parse_args().only_regions)
