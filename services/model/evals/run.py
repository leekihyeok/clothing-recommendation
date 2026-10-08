"""Evaluation sets for the two user-facing AI steps (PLAN.md 5·6단계): text → course request (/parse, 30 cases) and
"말로 고치기" (/edit-intent, 20 cases). Run before and after changing a prompt or a model; a drop in the score means
the change made things worse.

Each case checks only the fields it names, so a correct answer worded differently still passes:
  parse  where (region name or place contains it), styles_any / styles_all / styles_none, stop_count, max_stops,
         time [min, max] minutes, budget, items_all, wants_cafe, wants_food, unsupported (true = something listed)
  edit   one of the accepted op lists; each op compares op, order, to_order and any want_* / prefer it names

Results go to data/evals/<date>-<time>.json. Exit code 1 when a set scores under its threshold.
These are live AI calls (about 50, on the user-facing models), so run them by hand, not in CI.

Usage: python -m evals.run [--only parse|edit]
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from app.edit_intent import EditIntentRequest, Stop, edit_intent
from app.parse import ParseRequest, parse
from app.settings import REPO_ROOT
from pipeline.db import connect

HERE = Path(__file__).parent
THRESHOLD = {"parse": 0.85, "edit": 0.85}
QUOTA = ("RESOURCE_EXHAUSTED", "429")


class QuotaGone(Exception):
    """The free AI quota is used up: the rest of the run would only measure that."""


def attempt(fn):
    """(result, problems): an AI failure is a miss with its reason, except a used-up quota, which stops the run."""
    try:
        return fn()
    except Exception as e:
        if any(q in str(e) for q in QUOTA):
            raise QuotaGone(str(e)[:120]) from e
        return [f"error: {e!s:.200}"]


def check_parse(p, region_names: list[str], expect: dict) -> list[str]:
    """Problems found (empty = pass)."""
    problems = []
    styles = {s.id.value if hasattr(s.id, "value") else s.id for s in p.styles if s.weight > 0}
    items = {i.value if hasattr(i, "value") else i for i in p.items}
    if "where" in expect:
        w = expect["where"]
        if not ((p.region_name and w in p.region_name) or (p.place and w in p.place)):
            problems.append(f"where: wanted {w}, got region={p.region_name} place={p.place}")
    if "styles_any" in expect and not styles & set(expect["styles_any"]):
        problems.append(f"styles: wanted one of {expect['styles_any']}, got {sorted(styles)}")
    if "styles_all" in expect and not set(expect["styles_all"]) <= styles:
        problems.append(f"styles: wanted all of {expect['styles_all']}, got {sorted(styles)}")
    if expect.get("styles_none") and styles:
        problems.append(f"styles: wanted none, got {sorted(styles)}")
    if "stop_count" in expect and p.stop_count != expect["stop_count"]:
        problems.append(f"stop_count: wanted {expect['stop_count']}, got {p.stop_count}")
    if "max_stops" in expect and p.max_stops != expect["max_stops"]:
        problems.append(f"max_stops: wanted {expect['max_stops']}, got {p.max_stops}")
    if "time" in expect:
        lo, hi = expect["time"]
        if p.time_budget_min is None or not lo <= p.time_budget_min <= hi:
            problems.append(f"time: wanted {lo}-{hi}, got {p.time_budget_min}")
    if "budget" in expect and p.budget != expect["budget"]:
        problems.append(f"budget: wanted {expect['budget']}, got {p.budget}")
    if "must_shops" in expect:
        got = [n.replace(" ", "") for n in p.must_shops]
        for want in expect["must_shops"]:
            if not any(want in g for g in got):
                problems.append(f"must_shops: wanted {want}, got {p.must_shops}")
    if expect.get("must_none") and p.must_shops:
        problems.append(f"must_shops: wanted none, got {p.must_shops}")
    if "items_all" in expect and not set(expect["items_all"]) <= items:
        problems.append(f"items: wanted {expect['items_all']}, got {sorted(items)}")
    for flag in ("wants_cafe", "wants_food"):
        if flag in expect and getattr(p, flag) != expect[flag]:
            problems.append(f"{flag}: wanted {expect[flag]}, got {getattr(p, flag)}")
    if "unsupported" in expect and bool(p.unsupported) != expect["unsupported"]:
        problems.append(f"unsupported: wanted {expect['unsupported']}, got {p.unsupported}")
    return problems


def op_matches(got, want: dict) -> bool:
    g = got.model_dump()
    for k, v in want.items():
        val = g.get(k)
        val = val.value if hasattr(val, "value") else val
        if val != v:
            return False
    return True


def check_edit(intent, accepted: list[list[dict]]) -> list[str]:
    for option in accepted:
        if len(option) == len(intent.ops) and all(op_matches(g, w) for g, w in zip(intent.ops, option)):
            return []
    got = [{k: (v.value if hasattr(v, "value") else v) for k, v in o.model_dump().items() if v is not None} for o in intent.ops]
    return [f"ops: wanted one of {accepted}, got {got} (reply: {intent.reply})"]


def run_parse() -> dict:
    cases = json.loads((HERE / "parse_cases.json").read_text(encoding="utf-8"))
    with connect() as conn:
        regions = [r[0] for r in conn.execute("SELECT name FROM regions ORDER BY shop_count DESC")]
    results = []
    for c in cases:
        t0 = time.monotonic()
        try:
            problems = attempt(lambda: check_parse(parse(ParseRequest(text=c["text"], region_names=regions)).parsed, regions, c["expect"]))
        except QuotaGone as e:
            print(f"  -- AI quota used up, stopping ({e}); {len(cases) - len(results)} cases not run", flush=True)
            break
        results.append({"text": c["text"], "ok": not problems, "problems": problems, "ms": int((time.monotonic() - t0) * 1000)})
        print(("  ok  " if not problems else "  NO  ") + c["text"] + ("" if not problems else "  →  " + "; ".join(problems)), flush=True)
    return summarize("parse", results, len(cases))


def run_edit() -> dict:
    data = json.loads((HERE / "edit_cases.json").read_text(encoding="utf-8"))
    stops = [Stop(**s) for s in data["stops"]]
    results = []
    for c in data["cases"]:
        t0 = time.monotonic()
        try:
            problems = attempt(lambda: check_edit(edit_intent(EditIntentRequest(text=c["text"], stops=stops)), c["expect"]))
        except QuotaGone as e:
            print(f"  -- AI quota used up, stopping ({e}); {len(data['cases']) - len(results)} cases not run", flush=True)
            break
        results.append({"text": c["text"], "ok": not problems, "problems": problems, "ms": int((time.monotonic() - t0) * 1000)})
        print(("  ok  " if not problems else "  NO  ") + c["text"] + ("" if not problems else "  →  " + "; ".join(problems)), flush=True)
    return summarize("edit", results, len(data["cases"]))


def summarize(name: str, results: list[dict], planned: int) -> dict:
    passed = sum(r["ok"] for r in results)
    ms = sorted(r["ms"] for r in results) or [0]
    out = {
        "set": name, "passed": passed, "run": len(results), "planned": planned,
        "score": round(passed / len(results), 3) if results else 0.0, "complete": len(results) == planned,
        "threshold": THRESHOLD[name], "p50_ms": ms[len(ms) // 2], "max_ms": ms[-1], "results": results,
    }
    note = "" if out["complete"] else f" — only {len(results)} of {planned} run (AI quota)"
    print(f"{name}: {passed}/{len(results)} ({out['score']:.0%}), median {out['p50_ms']} ms{note}", flush=True)
    return out


def main(only: str | None) -> int:
    report = {"at": datetime.now().isoformat(timespec="seconds"), "sets": []}
    if only in (None, "parse"):
        print("parse set:")
        report["sets"].append(run_parse())
    if only in (None, "edit"):
        print("edit set:")
        report["sets"].append(run_edit())
    out_dir = REPO_ROOT / "data" / "evals"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{datetime.now():%Y%m%d-%H%M}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved {path}")
    # An incomplete run proves nothing either way: exit 2 so it isn't mistaken for a pass.
    if not all(s["complete"] for s in report["sets"]):
        return 2
    return 0 if all(s["score"] >= s["threshold"] for s in report["sets"]) else 1


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--only", choices=["parse", "edit"])
    sys.exit(main(p.parse_args().only))
