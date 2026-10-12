"""Pipeline ⑧: the long-running keeper. Started at Windows logon (scripts/pipeline-bg.ps1, Task Scheduler), it
keeps the shop data fresh on its own (PLAN.md 5.4):

  between regions  the quality work (evidence → score → verify, two passes like pipeline.quality_run), one region at
                   a time, so the scheduled jobs below never wait days behind it
  weekly           stale check (no mention for a year and gone from Kakao Map → suspended), re-check suspended shops,
                   presets
  monthly          Kakao sweep for new places → link them to shops (incremental, existing shops untouched) → classify
                   the new ones; places that didn't come back → suspended for the re-check; fresh evidence for up to
                   3,000 shops whose evidence is over six months old (they get re-scored by the quality work)
  quarterly        a reminder only: the public data (상가(상권)정보) has to be downloaded by hand

When a job is due is read from pipeline_runs, so restarts don't repeat or skip anything. With nothing to do it sleeps
and looks again. If the DB is down (Docker not up yet after logon) it waits. data/logs/STOP stops it after the
current step.

Usage: python -m pipeline.refresh [--once]
"""

import argparse
import time
import traceback
from datetime import datetime, timedelta, timezone

from pipeline import aliases, blogs, classify, closures, dedupe, kakao, merge_dupes, presets, quality_run, retention
from pipeline.db import connect, pipeline_run
from pipeline.quality_run import PRIORITY, STOP_FILE, catch_up, gave_up_recently, label_of, log, process, remaining, start_heartbeat

WEEK = timedelta(days=7)
MONTH = timedelta(days=30)
QUARTER = timedelta(days=90)
IDLE_SLEEP_S = 30 * 60
DB_WAIT_S = 2 * 60
STALE_PER_WEEK = 300
KAKAO_MAX_REQUESTS = 30000
EVIDENCE_REFRESH_PER_MONTH = 3000
EVIDENCE_MAX_AGE_DAYS = 180


def last_ok(*steps: str) -> datetime | None:
    with connect() as conn:
        return conn.execute(
            "SELECT max(finished_at) FROM pipeline_runs WHERE status = 'ok' AND step = ANY(%s)", (list(steps),)
        ).fetchone()[0]


def due(every: timedelta, *steps: str) -> bool:
    last = last_ok(*steps)
    return last is None or datetime.now(timezone.utc) - last >= every


def weekly() -> dict:
    with connect() as conn, pipeline_run(conn, "refresh_weekly") as stats:
        stats["stale"] = _short(closures.stale_check(STALE_PER_WEEK))
        stats["closures"] = _short(closures.run(None))
        stats["presets"] = len(presets.run(2, 8, False)["presets"])
        # Personal data past its keep-by date (pipeline.retention).
        stats["retention"] = _short(retention.run(False))
    return stats


def monthly() -> dict:
    with connect() as conn, pipeline_run(conn, "refresh_monthly") as stats:
        started = conn.execute("SELECT now()").fetchone()[0]
        try:
            stats["kakao"] = {"requests": kakao.run(kakao.KEYWORDS, KAKAO_MAX_REQUESTS)["requests"]}
            complete = True
        except RuntimeError as e:  # request budget used up, repeated failures: keep what came in, don't trust gaps
            stats["kakao"] = {"error": str(e)[:300]}
            complete = False
        stats["dedupe"] = {k: v for k, v in dedupe.run(0.3, incremental=True).items() if k in ("new_shops", "matched_near", "to_complex")}
        stats["classify"] = {k: v for k, v in classify.run(False, None, 60).items() if k in ("ai_todo", "ai_done")}
        # New Kakao places can be a shop we already have under its other-script name ("EQL" / "이큐엘").
        stats["merge_dupes"] = merge_dupes.run(False)["merged"]
        stats["vanished"] = _short(closures.vanished(started)) if complete else "skipped: sweep incomplete"
        stats["closures"] = _short(closures.run(None))
        # Spread over months: re-collecting everything at once would mean re-scoring ~24k shops on the free AI tier.
        stats["evidence_refresh"] = _short(blogs.run(None, EVIDENCE_REFRESH_PER_MONTH, EVIDENCE_MAX_AGE_DAYS))
        stats["aliases"] = _short(aliases.run(None, None))
    return stats


def remind_public_data() -> None:
    last = last_ok("import_sbiz")
    if last and datetime.now(timezone.utc) - last >= QUARTER:
        log(f"reminder: public data (상가(상권)정보) imported {last:%Y-%m-%d}; download the new edition and run pipeline.sbiz")


def quality_items():
    with connect() as conn:
        regions = [r[0] for r in conn.execute("SELECT name FROM regions ORDER BY shop_count DESC")]
    yield from ((r, PRIORITY) for r in regions)
    yield from ((r, None) for r in regions)
    yield None, PRIORITY
    yield None, None


def next_quality_item():
    for region, categories in quality_items():
        # A region whose step was just given up waits a few hours, so the others aren't stuck behind it.
        if gave_up_recently(label_of(region, categories)):
            continue
        if any(remaining(region, categories)):
            return region, categories
    return None


def _short(stats: dict) -> dict:
    return {k: v for k, v in stats.items() if k not in ("run_id", "region")}


def tick() -> bool:
    """One round: due jobs first, then one region of quality work. False when there was nothing to do."""
    did = False
    if due(WEEK, "refresh_weekly"):
        quality_run.step("weekly", weekly)
        did = True
    if due(MONTH, "refresh_monthly", "kakao_grid"):
        quality_run.step("monthly", monthly)
        did = True
    item = next_quality_item()
    if item:
        process(*item)
        did = True
    elif catch_up():
        did = True
    return did


def main(once: bool) -> None:
    log("refresh: start")
    start_heartbeat()
    reminded = None
    while True:
        if STOP_FILE.exists():
            log("refresh: STOP file found")
            return
        try:
            if reminded is None or datetime.now() - reminded >= WEEK:
                remind_public_data()
                reminded = datetime.now()
            busy = tick()
        except SystemExit:
            raise
        except Exception as e:  # mostly the DB not being up yet after logon
            log(f"refresh: {e!s:.200} — waiting {DB_WAIT_S // 60} min\n{traceback.format_exc(limit=2)}")
            time.sleep(DB_WAIT_S)
            continue
        if once and not busy:
            log("refresh: nothing left to do")
            return
        if not busy:
            time.sleep(IDLE_SLEEP_S)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--once", action="store_true", help="stop when there is nothing left to do instead of waiting")
    main(p.parse_args().once)
