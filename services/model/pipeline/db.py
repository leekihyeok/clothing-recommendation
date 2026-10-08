"""Database access for pipeline jobs, plus the pipeline_runs bookkeeping every job uses."""

import json
from contextlib import contextmanager
from typing import Iterator

import psycopg

from app.settings import settings


def connect() -> psycopg.Connection:
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is not set (.env)")
    return psycopg.connect(settings.database_url)


@contextmanager
def pipeline_run(conn: psycopg.Connection, step: str) -> Iterator[dict]:
    """Records a pipeline_runs row. The caller fills the yielded dict with stats; it is saved on exit."""
    run_id = conn.execute("INSERT INTO pipeline_runs (step) VALUES (%s) RETURNING id", (step,)).fetchone()[0]
    conn.commit()
    stats: dict = {"run_id": run_id}
    try:
        yield stats
    except BaseException as e:
        conn.rollback()
        conn.execute(
            "UPDATE pipeline_runs SET status = 'failed', error = %s, stats = %s, finished_at = now() WHERE id = %s",
            (repr(e), json.dumps(stats, ensure_ascii=False), run_id),
        )
        conn.commit()
        raise
    conn.execute(
        "UPDATE pipeline_runs SET status = 'ok', stats = %s, finished_at = now() WHERE id = %s",
        (json.dumps(stats, ensure_ascii=False), run_id),
    )
    conn.commit()


def refuse_if_user_data(conn) -> None:
    """Full shop rebuilds give shops new ids; once users saved or visited shops that would orphan their data."""
    n = conn.execute("SELECT count(*) FROM user_shop_events").fetchone()[0]
    if n:
        raise SystemExit(
            f"refusing to rebuild shops: {n} user events point at current shop ids (내 가게). "
            "Add new sources incrementally instead, or migrate the events first."
        )
