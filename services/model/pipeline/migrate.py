"""Applies infra/migrations/*.sql in name order, once each. Usage: python -m pipeline.migrate"""

from app.settings import REPO_ROOT
from pipeline.db import connect

MIGRATIONS_DIR = REPO_ROOT / "infra" / "migrations"


def migrate() -> list[str]:
    applied_now = []
    with connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                continue
            with conn.transaction():
                conn.execute(path.read_text(encoding="utf-8"))
                conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
            applied_now.append(path.name)
    return applied_now


if __name__ == "__main__":
    applied = migrate()
    print("applied:", ", ".join(applied) if applied else "nothing (up to date)")
