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
import json
import os
import threading
import time
import traceback
from datetime import datetime, timedelta

from ai import AIError
from app.settings import REPO_ROOT
from pipeline import aliases, blogs, brands, closures, embed, gender, hours, translate, presets, recheck_category, reputation, score, verify, wrong_evidence
from pipeline.db import connect

STOP_FILE = REPO_ROOT / "data" / "logs" / "STOP"
HEARTBEAT_FILE = REPO_ROOT / "data" / "logs" / "heartbeat.json"
HEARTBEAT_EVERY_S = 5 * 60
# A failing step is tried again after 5, 20 and 60 minutes, then given up until the next round (the region is left
# alone for GIVE_UP_FOR); a step that failed because today's AI budget is used up is skipped at once.
RETRY_WAITS_S = [5 * 60, 20 * 60, 60 * 60]
GIVE_UP_FOR = timedelta(hours=6)
_gave_up: dict[str, datetime] = {}  # process label → when one of its steps was given up
_state = {"step": "start"}


def log(msg: str) -> None:
    print(f"[{datetime.now():%m-%d %H:%M:%S}] {msg}", flush=True)


def _beat() -> None:
    try:
        HEARTBEAT_FILE.write_text(
            json.dumps({"at": datetime.now().isoformat(timespec="seconds"), "pid": os.getpid(), "step": _state["step"]}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass


def start_heartbeat() -> None:
    """Every 5 minutes data/logs/heartbeat.json says the keeper is alive and what it's doing; pipeline.status warns
    when it goes quiet (the keeper died or hung, as on 10/9–10/10 when nobody noticed for two days)."""

    def loop() -> None:
        while True:
            _beat()
            time.sleep(HEARTBEAT_EVERY_S)

    threading.Thread(target=loop, name="heartbeat", daemon=True).start()


def gave_up_recently(label: str) -> bool:
    at = _gave_up.get(label)
    return at is not None and datetime.now() - at < GIVE_UP_FOR


def label_of(region: str | None, categories: list[str] | None) -> str:
    return (region or "서울 나머지") + (" (편집숍·빈티지·브랜드)" if categories else "")


def _budget_used(e: Exception) -> bool:
    """Today's free AI quota is gone (our batch cap, or Google's daily limit): waiting minutes won't help."""
    text = str(e)
    return "daily batch budget" in text or "daily quota used up" in text


# Pass 1: the shop types style courses are made of.
PRIORITY = ["select_shop", "vintage", "brand"]


def remaining(region: str | None, categories: list[str] | None = None) -> tuple[int, int, int, int, int]:
    in_region = "" if region is None else "AND EXISTS (SELECT 1 FROM regions g WHERE g.name = %(r)s AND ST_Intersects(g.polygon, s.geom))"
    if categories:
        in_region += " AND s.category = ANY(%(c)s)"
    with connect() as conn:
        return conn.execute(
            f"""SELECT count(*) FILTER (WHERE s.evidence_at IS NULL),
                       count(*) FILTER (WHERE s.evidence_at IS NOT NULL AND s.scored_at IS NULL),
                       count(*) FILTER (WHERE s.scored_at IS NOT NULL AND s.confidence IS NULL),
                       count(*) FILTER (WHERE coalesce(s.matched_posts, 0) > 0 AND s.evidence_at IS NOT NULL
                                          AND (s.reputation_at IS NULL OR s.reputation_at < s.evidence_at)),
                       count(*) FILTER (WHERE s.evidence_at IS NOT NULL AND (s.hours_at IS NULL OR s.hours_at < s.evidence_at)
                                          AND EXISTS (SELECT 1 FROM shop_facts f WHERE f.shop_id = s.id AND f.snippet ~ %(h)s))
                FROM shops s
                WHERE s.kind = 'store' AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
                {in_region}""",
            {"r": region, "c": categories, "h": hours.HINT_SQL},
        ).fetchone()


def step(name: str, fn) -> bool:
    """Runs one step, retrying a few times with longer waits; False when it was given up (the caller moves on)."""
    for attempt, wait in enumerate([*RETRY_WAITS_S, None]):
        if STOP_FILE.exists():
            raise SystemExit("STOP file found")
        _state["step"] = name
        try:
            result = fn()
            log(f"  {name}: {result}")
            return True
        except (AIError, RuntimeError) as e:  # quota, overload, network
            if _budget_used(e):
                log(f"  {name}: today's AI budget is used up — skipped until it resets ({e!s:.160})")
                return False
            log(f"  {name} failed (try {attempt + 1}): {e!s:.300}")
        except Exception:
            log(f"  {name} crashed (try {attempt + 1}):\n{traceback.format_exc()}")
        if wait is None:
            log(f"  {name}: gave up after {attempt + 1} tries — moving on, back to it in a later round")
            return False
        log(f"  {name}: retrying in {wait // 60} min")
        _state["step"] = f"{name} (waiting to retry)"
        time.sleep(wait)
    return False


def suspended() -> int:
    with connect() as conn:
        return conn.execute("SELECT count(*) FROM shops WHERE status = 'suspended'").fetchone()[0]


def process(region: str | None, categories: list[str] | None = None) -> None:
    label = label_of(region, categories)
    # Shops "문 닫혀 있었어요" reports took out get re-checked between regions (Kakao only, no AI).
    if suspended():
        step("closures", lambda: _short(closures.run(None)))
    todo = remaining(region, categories)
    log(f"{label}: evidence {todo[0]}, score {todo[1]}, verify {todo[2]}, reputation {todo[3]}, hours {todo[4]} to go")
    if not any(todo):
        return
    steps = [
        ("evidence", lambda: _short(blogs.run(region, None, 30, retry_empty=False, categories=categories))),
        ("aliases", lambda: _short(aliases.run(region, None, categories=categories))),
        ("score", lambda: _short(score.run(region, None, False, 8, categories=categories))),
        ("verify", lambda: _short(verify.run(region, None, 8, categories=categories))),
        # Confidence 0 = the posts were about something else: drop what was read from them (no AI).
        ("wrong evidence", lambda: _short(wrong_evidence.run(False))),
        ("reputation", lambda: _short(reputation.run(region, None, 10, categories=categories))),
        ("hours", lambda: _short(hours.run(region, None, 12, categories=categories))),
        # Brands the posts say a select or vintage shop carries ("브랜드로 찾기"); brand stores from their names.
        ("brands", lambda: _short(brands.run(region, None, 10, categories=categories))),
        # Newly scored shops get their "비슷한 가게" embedding (its own free quota, ~100 shops a call).
        ("embed", lambda: _short(embed.run(region, None, categories=categories))),
        # English for the new summaries, region and preset texts (the app's English mode); a few calls per region.
        ("translate", lambda: _short(translate.run(200, 40))),
        # Scores and summaries now exist: fix categories the name alone got wrong ("오티코티" brand → vintage).
        ("recheck category", lambda: {"changed": recheck_category.run(False, region)["changed"]}),
        ("gender", lambda: {"changed": gender.run(False)["changed"]}),
    ]
    # More shops with real style scores → better first-screen ideas. Once a day is enough (it used to run after
    # every region and spent the AI calls kept for people).
    if region is not None and not presets.done_today():
        steps.append(("presets", lambda: {"presets": len(presets.run(2, 8, False)["presets"])}))
    for name, fn in steps:
        if not step(name, fn):
            _gave_up[label] = datetime.now()
    _state["step"] = "between regions"


def leftovers() -> tuple[int, int]:
    """Embeddings and English still missing anywhere. Regions whose other steps are all done are never processed
    again, so these would otherwise wait forever."""
    with connect() as conn:
        emb = conn.execute(
            """SELECT count(*) FROM shops s WHERE s.status = 'candidate' AND s.summary IS NOT NULL AND s.scored_at IS NOT NULL
                 AND (s.embedded_at IS NULL OR s.embedded_at < s.scored_at)"""
        ).fetchone()[0]
        tr = len(translate.pending(conn, 1))
    return emb, tr


def catch_up() -> bool:
    """Fills leftover embeddings and translations across Seoul. True when it got something done (so the keeper
    doesn't spin when today's quota is the only thing in the way)."""
    emb, tr = leftovers()
    did = False
    if emb and not gave_up_recently("embed (all)"):
        stats: dict = {}

        def run_embed():
            stats.update(_short(embed.run(None, None)))
            return stats

        if not step("embed (all)", run_embed):
            _gave_up["embed (all)"] = datetime.now()
        did |= stats.get("done", 0) > 0
    if tr and not gave_up_recently("translate (all)"):
        stats2: dict = {}

        def run_translate():
            stats2.update(_short(translate.run(400, 40)))
            return stats2

        if not step("translate (all)", run_translate):
            _gave_up["translate (all)"] = datetime.now()
        did |= stats2.get("done", 0) > 0
    return did


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
