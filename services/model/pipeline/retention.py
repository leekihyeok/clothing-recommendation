"""Pipeline step (weekly, with the data refresh): personal data kept no longer than it's needed.

  - anonymous browsers not seen for a year: the user row goes, with its shop records (찜·다녀옴·평가) and events;
    courses they made stay, without an owner
  - owner claims decided over 180 days ago: the applicant's name, contact and message are blanked (the decision, the
    business number and who reviewed it stay, for the record of who owns which shop); the certificate photo is already
    deleted when the claim is decided
  - usage events (app_events) older than 400 days, expired login sessions, and the undo stacks of courses not edited
    for 30 days (only needed while someone is editing)

Usage: python -m pipeline.retention [--dry-run]
"""

import argparse
import json

from pipeline.db import connect, pipeline_run

ANON_DAYS = 365
CLAIM_DAYS = 180
EVENT_DAYS = 400
UNDO_DAYS = 30

STEPS = [
    ("anon_users", f"""DELETE FROM users WHERE kind = 'anon' AND last_seen_at < now() - interval '{ANON_DAYS} days'"""),
    ("claims_blanked", f"""UPDATE shop_owner_claims SET owner_name = '(지움)', contact = '(지움)', message = NULL
                           WHERE status <> 'pending' AND coalesce(reviewed_at, created_at) < now() - interval '{CLAIM_DAYS} days'
                             AND owner_name <> '(지움)'"""),
    ("events", f"""DELETE FROM app_events WHERE created_at < now() - interval '{EVENT_DAYS} days'"""),
    ("sessions", """DELETE FROM sessions WHERE expires_at < now()"""),
    ("undo_stacks", f"""UPDATE courses SET undo = '[]' WHERE undo <> '[]'
                        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(edits) e
                                        WHERE (e->>'at')::timestamptz > now() - interval '{UNDO_DAYS} days')"""),
]


def run(dry_run: bool) -> dict:
    with connect() as conn, pipeline_run(conn, "retention") as stats:
        for name, sql in STEPS:
            cur = conn.execute(sql)
            stats[name] = cur.rowcount
        if dry_run:
            conn.rollback()
            stats["dry_run"] = True
        else:
            conn.commit()
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    print(json.dumps(run(a.dry_run), ensure_ascii=False, indent=2))
